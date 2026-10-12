// Firebase とのやり取り(ログイン、本棚の同期、ユーザー管理)
// 失敗は Error(code) で返す。code は app.js で日本語のメッセージに変える。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import {
  initializeAuth, browserSessionPersistence, inMemoryPersistence, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import {
  initializeFirestore, memoryLocalCache, doc, getDoc, getDocs, collection,
  onSnapshot, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { normalizeUserId, isValidUserId, loginEmail, userIdFromEmail, parseBackup } from './store.js';

const BATCH_SIZE = 400;

let app, auth, db;
let secondaryAuth; // 管理者がユーザーを作るときに使う(管理者自身のログインを保つため)

export function initCloud() {
  app = initializeApp(firebaseConfig);
  // タブやアプリを閉じるとログアウトされる
  auth = initializeAuth(app, { persistence: browserSessionPersistence });
  // 共用端末にデータを残さないよう、キャッシュはメモリだけ
  db = initializeFirestore(app, { localCache: memoryLocalCache() });
}

function getSecondaryAuth() {
  if (!secondaryAuth) {
    secondaryAuth = initializeAuth(initializeApp(firebaseConfig, 'secondary'), { persistence: inMemoryPersistence });
  }
  return secondaryAuth;
}

const fail = code => { throw new Error(code); };

function codeOf(e) {
  const c = (e && e.code) || '';
  if (/network-request-failed|unavailable|failed-precondition|deadline-exceeded/.test(c)) return 'network';
  if (/invalid-credential|wrong-password|user-not-found|invalid-email|user-mismatch/.test(c)) return 'bad-credentials';
  if (/too-many-requests/.test(c)) return 'too-many';
  if (/weak-password/.test(c)) return 'weak';
  if (/requires-recent-login/.test(c)) return 'bad-credentials';
  if (/permission-denied/.test(c)) return 'permission';
  if (/configuration-not-found|operation-not-allowed|admin-restricted-operation/.test(c)) return 'auth-config';
  return (e && e.message) || 'unknown';
}

// Firebase の例外を code 付きの Error にそろえる
async function wrap(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof Error && !e.code) throw e; // 自分で投げた Error(code)
    throw new Error(codeOf(e));
  }
}

const newShelfId = () => crypto.randomUUID().replace(/-/g, '');
const memberRef = id => doc(db, 'members', id);
const loginRef = id => doc(db, 'logins', id);

// ---------- ログイン ----------

export function setupStatus() {
  return wrap(async () => (await getDoc(doc(db, 'config', 'setup'))).exists());
}

async function sessionFor(userId, uid) {
  let snap;
  try { snap = await getDoc(memberRef(userId)); } catch (e) {
    if (codeOf(e) === 'permission') return { error: 'bad-credentials' };
    throw e;
  }
  if (!snap.exists() || snap.data().uid !== uid) return { error: 'bad-credentials' };
  const m = snap.data();
  if (m.disabled) return { error: 'disabled' };
  return { session: { userId, role: m.role, shelfId: m.shelfId } };
}

// 同じタブで再読み込みしたときは、ログイン状態を引き継ぐ
export function restoreSession() {
  return wrap(async () => {
    const user = await new Promise(resolve => {
      const off = onAuthStateChanged(auth, u => { off(); resolve(u); });
    });
    const userId = user && userIdFromEmail(user.email);
    if (!userId) return null;
    const r = await sessionFor(userId, user.uid);
    if (r.error) { await signOut(auth); return null; }
    return r.session;
  });
}

export function login(rawId, password) {
  return wrap(async () => {
    const userId = normalizeUserId(rawId);
    if (!isValidUserId(userId)) fail('bad-credentials');
    const l = await getDoc(loginRef(userId));
    if (!l.exists()) fail('bad-credentials');
    const cred = await signInWithEmailAndPassword(auth, loginEmail(userId, l.data().gen), password);
    const r = await sessionFor(userId, cred.user.uid);
    if (r.error) { await signOut(auth); fail(r.error); }
    return r.session;
  });
}

export function setupAdmin(rawId, password) {
  return wrap(async () => {
    const userId = normalizeUserId(rawId);
    if (!isValidUserId(userId)) fail('invalid-id');
    const email = loginEmail(userId, 1);
    let cred;
    try {
      cred = await createUserWithEmailAndPassword(auth, email, password);
    } catch (e) {
      // 前回の初期設定が途中で止まっていた場合は、そのアカウントで続きを行う
      if (e.code === 'auth/email-already-in-use') cred = await signInWithEmailAndPassword(auth, email, password);
      else throw e;
    }
    const shelfId = newShelfId();
    const b = writeBatch(db);
    b.set(doc(db, 'config', 'setup'), { adminUserId: userId, createdAt: serverTimestamp() });
    b.set(memberRef(userId), { uid: cred.user.uid, gen: 1, role: 'admin', disabled: false, shelfId, createdAt: serverTimestamp() });
    b.set(loginRef(userId), { gen: 1 });
    try { await b.commit(); } catch (e) {
      await signOut(auth);
      throw new Error(codeOf(e) === 'permission' ? 'setup-done' : codeOf(e));
    }
    return { userId, role: 'admin', shelfId };
  });
}

export function logout() {
  return signOut(auth).catch(() => {});
}

export function changePassword(current, next) {
  return wrap(async () => {
    const user = auth.currentUser;
    if (!user) fail('bad-credentials');
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
    await updatePassword(user, next);
  });
}

// ---------- 本棚の同期 ----------

export function subscribeShelf(session, onState, onError) {
  const parts = { links: null, folders: null };
  const emit = () => {
    if (!parts.links || !parts.folders) return;
    // 形式をそろえるため、バックアップの読み込みと同じ検証を通す
    onState(parseBackup(JSON.stringify({ links: parts.links, folders: parts.folders })));
  };
  const offs = ['links', 'folders'].map(name =>
    onSnapshot(
      collection(db, 'shelves', session.shelfId, name),
      snap => { parts[name] = snap.docs.map(d => ({ ...d.data(), id: d.id })); emit(); },
      e => onError(codeOf(e)),
    ));
  return () => offs.forEach(off => off());
}

export function writeDiff(session, diff) {
  return wrap(async () => {
    const ops = [];
    for (const name of ['links', 'folders']) {
      for (const item of diff[name].set) {
        const { id, ...data } = item;
        ops.push(b => b.set(doc(db, 'shelves', session.shelfId, name, id), data));
      }
      for (const id of diff[name].del) ops.push(b => b.delete(doc(db, 'shelves', session.shelfId, name, id)));
    }
    for (let i = 0; i < ops.length; i += BATCH_SIZE) {
      const b = writeBatch(db);
      ops.slice(i, i + BATCH_SIZE).forEach(op => op(b));
      await b.commit();
    }
  });
}

// ---------- ユーザー管理(管理者) ----------

export function listMembers() {
  return wrap(async () => {
    const snap = await getDocs(collection(db, 'members'));
    return snap.docs.map(d => ({ userId: d.id, ...d.data() }))
      .sort((a, b) => (a.role === 'admin' ? -1 : 0) - (b.role === 'admin' ? -1 : 0) || a.userId.localeCompare(b.userId));
  });
}

// 世代 gen から始めて、使われていないメールアドレスでアカウントを作る
async function createAccount(userId, gen, password) {
  const sec = getSecondaryAuth();
  for (let i = 0; i < 5; i++, gen++) {
    try {
      const cred = await createUserWithEmailAndPassword(sec, loginEmail(userId, gen), password);
      await signOut(sec);
      return { uid: cred.user.uid, gen };
    } catch (e) {
      if (e.code !== 'auth/email-already-in-use') throw e;
    }
  }
  fail('unknown');
}

function currentUserId() {
  return userIdFromEmail(auth.currentUser && auth.currentUser.email);
}

export function createMember(rawId, password) {
  return wrap(async () => {
    const userId = normalizeUserId(rawId);
    if (!isValidUserId(userId)) fail('invalid-id');
    if ((await getDoc(memberRef(userId))).exists()) fail('exists');
    const l = await getDoc(loginRef(userId));
    const { uid, gen } = await createAccount(userId, l.exists() ? l.data().gen + 1 : 1, password);
    const b = writeBatch(db);
    b.set(memberRef(userId), { uid, gen, role: 'user', disabled: false, shelfId: newShelfId(), createdAt: serverTimestamp() });
    b.set(loginRef(userId), { gen });
    await b.commit();
  });
}

// 新しい世代のアカウントを作って付け替える(古いパスワードは使えなくなる)
export function resetPassword(userId, password) {
  return wrap(async () => {
    if (userId === currentUserId()) fail('self');
    const m = await getDoc(memberRef(userId));
    if (!m.exists()) fail('not-found');
    const { uid, gen } = await createAccount(userId, m.data().gen + 1, password);
    const b = writeBatch(db);
    b.update(memberRef(userId), { uid, gen });
    b.set(loginRef(userId), { gen });
    await b.commit();
  });
}

export function setDisabled(userId, disabled) {
  return wrap(async () => {
    if (userId === currentUserId()) fail('self');
    const b = writeBatch(db);
    b.update(memberRef(userId), { disabled });
    await b.commit();
  });
}

export function deleteMember(userId) {
  return wrap(async () => {
    if (userId === currentUserId()) fail('self');
    const b = writeBatch(db);
    b.delete(memberRef(userId));
    await b.commit();
  });
}
