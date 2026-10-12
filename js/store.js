// データ操作。DOM に依存しない純粋なロジックだけを置く。
// state = { version: 1, links: Link[], folders: Folder[] }

export const ROOT_LABEL = '本棚(いちばん上)';

export function emptyState() {
  return { version: 1, links: [], folders: [] };
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 同じミリ秒に作っても順序が崩れないよう、単調増加させる
let lastTime = 0;
function now() {
  lastTime = Math.max(Date.now(), lastTime + 1);
  return lastTime;
}

function normCover(c) {
  const type = c && ['auto', 'color', 'image'].includes(c.type) ? c.type : 'auto';
  const cover = { type, color: c && Number.isInteger(c.color) ? c.color : 0 };
  if (c && typeof c.image === 'string') cover.image = c.image;
  if (c && typeof c.autoUrl === 'string') cover.autoUrl = c.autoUrl;
  return cover;
}

// ---- リンク ----

export function addLink(state, { url, title = '', folderId = null, cover } = {}) {
  const link = { id: newId(), url, title, folderId, cover: normCover(cover), fav: false, createdAt: now() };
  state.links.push(link);
  return link;
}

export function updateLink(state, id, patch) {
  const link = state.links.find(l => l.id === id);
  if (!link) return null;
  Object.assign(link, patch);
  if (patch.cover) link.cover = normCover(patch.cover);
  return link;
}

export function deleteLink(state, id) {
  state.links = state.links.filter(l => l.id !== id);
}

export function toggleFav(state, id) {
  const link = state.links.find(l => l.id === id);
  if (link) link.fav = !link.fav;
  return link;
}

// ---- フォルダー ----

export function addFolder(state, { name, parentId = null, color = 0 } = {}) {
  const folder = { id: newId(), name, parentId, color, createdAt: now() };
  state.folders.push(folder);
  return folder;
}

export function descendantIds(state, folderId) {
  const result = new Set();
  const stack = [folderId];
  while (stack.length) {
    const id = stack.pop();
    for (const f of state.folders) {
      if (f.parentId === id && !result.has(f.id)) { result.add(f.id); stack.push(f.id); }
    }
  }
  return result;
}

export function canMoveFolder(state, folderId, newParentId) {
  if (newParentId === null) return true;
  if (newParentId === folderId) return false;
  if (!state.folders.some(f => f.id === newParentId)) return false;
  return !descendantIds(state, folderId).has(newParentId);
}

export function updateFolder(state, id, patch) {
  const folder = state.folders.find(f => f.id === id);
  if (!folder) return null;
  if ('parentId' in patch && !canMoveFolder(state, id, patch.parentId)) throw new Error('invalid-parent');
  Object.assign(folder, patch);
  return folder;
}

export function countInside(state, folderId) {
  return {
    links: state.links.filter(l => l.folderId === folderId).length,
    folders: state.folders.filter(f => f.parentId === folderId).length,
  };
}

export function countDeep(state, folderId) {
  const ids = descendantIds(state, folderId);
  ids.add(folderId);
  return {
    links: state.links.filter(l => ids.has(l.folderId)).length,
    folders: ids.size - 1,
  };
}

// mode: 'lift' = 中身を 1 つ上に出す / 'all' = 中身ごと削除
export function deleteFolder(state, folderId, mode) {
  const folder = state.folders.find(f => f.id === folderId);
  if (!folder) return;
  if (mode === 'all') {
    const ids = descendantIds(state, folderId);
    ids.add(folderId);
    state.links = state.links.filter(l => !ids.has(l.folderId));
    state.folders = state.folders.filter(f => !ids.has(f.id));
    return;
  }
  for (const l of state.links) if (l.folderId === folderId) l.folderId = folder.parentId;
  for (const f of state.folders) if (f.parentId === folderId) f.parentId = folder.parentId;
  state.folders = state.folders.filter(f => f.id !== folderId);
}

export function pathOf(state, folderId) {
  const path = [];
  const seen = new Set();
  let id = folderId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const f = state.folders.find(x => x.id === id);
    if (!f) break;
    path.unshift(f);
    id = f.parentId;
  }
  return path;
}

// 「入れる場所」の選択肢。excludeId とその子孫は除く
export function folderOptions(state, excludeId) {
  const excluded = excludeId ? descendantIds(state, excludeId) : new Set();
  if (excludeId) excluded.add(excludeId);
  const options = [{ id: null, label: ROOT_LABEL, depth: 0 }];
  const walk = (parentId, depth) => {
    for (const f of sortFolders(state.folders.filter(x => x.parentId === parentId), 'name')) {
      if (excluded.has(f.id)) continue;
      options.push({ id: f.id, label: f.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  return options;
}

// ---- 並び替え・表示 ----

const byName = (a, b) => a.localeCompare(b, 'ja');

export function sortLinks(links, sort) {
  const arr = [...links];
  const newest = (a, b) => b.createdAt - a.createdAt;
  switch (sort) {
    case 'old': return arr.sort((a, b) => a.createdAt - b.createdAt);
    case 'name': return arr.sort((a, b) => byName(a.title, b.title) || newest(a, b));
    case 'name-desc': return arr.sort((a, b) => byName(b.title, a.title) || newest(a, b));
    case 'fav': return arr.sort((a, b) => (b.fav - a.fav) || newest(a, b));
    default: return arr.sort(newest);
  }
}

export function sortFolders(folders, sort) {
  const arr = [...folders];
  const newest = (a, b) => b.createdAt - a.createdAt;
  switch (sort) {
    case 'old': return arr.sort((a, b) => a.createdAt - b.createdAt);
    case 'name': return arr.sort((a, b) => byName(a.name, b.name) || newest(a, b));
    case 'name-desc': return arr.sort((a, b) => byName(b.name, a.name) || newest(a, b));
    default: return arr.sort(newest);
  }
}

export function view(state, { folderId = null, query = '', filter = 'all', sort = 'new' } = {}) {
  const q = query.trim().toLowerCase();
  if (q || filter === 'fav') {
    let links = state.links;
    if (filter === 'fav') links = links.filter(l => l.fav);
    if (q) links = links.filter(l => (l.title || '').toLowerCase().includes(q) || (l.url || '').toLowerCase().includes(q));
    return { mode: 'flat', folders: [], links: sortLinks(links, sort) };
  }
  return {
    mode: 'folder',
    folders: sortFolders(state.folders.filter(f => f.parentId === folderId), sort),
    links: sortLinks(state.links.filter(l => l.folderId === folderId), sort),
  };
}

// ---- バックアップ ----

export function serialize(state) {
  return JSON.stringify(state);
}

export function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('invalid-backup'); }
  if (Array.isArray(data)) data = { links: data };
  if (!data || !Array.isArray(data.links)) throw new Error('invalid-backup');
  const rawFolders = Array.isArray(data.folders) ? data.folders : [];

  const folders = rawFolders.map(f => {
    if (!f || typeof f.id !== 'string' || typeof f.name !== 'string') throw new Error('invalid-backup');
    return {
      id: f.id, name: f.name,
      parentId: typeof f.parentId === 'string' ? f.parentId : null,
      color: Number.isInteger(f.color) ? f.color : 0,
      createdAt: Number(f.createdAt) || 0,
    };
  });
  const folderIds = new Set(folders.map(f => f.id));
  for (const f of folders) if (!folderIds.has(f.parentId)) f.parentId = null;
  // 親をたどってループするフォルダーは直下に出す
  for (const f of folders) {
    const seen = new Set([f.id]);
    let p = f.parentId;
    while (p) {
      if (seen.has(p)) { f.parentId = null; break; }
      seen.add(p);
      p = folders.find(x => x.id === p).parentId;
    }
  }

  const links = data.links.map(l => {
    if (!l || typeof l.url !== 'string') throw new Error('invalid-backup');
    return {
      id: typeof l.id === 'string' ? l.id : newId(),
      url: l.url,
      title: typeof l.title === 'string' ? l.title : '',
      folderId: folderIds.has(l.folderId) ? l.folderId : null,
      cover: normCover(l.cover),
      fav: !!l.fav,
      createdAt: Number(l.createdAt) || 0,
    };
  });
  return { version: 1, links, folders };
}

// ---- ログイン・同期 ----

export const LOGIN_DOMAIN = 'users.link-shelf.example';

export function normalizeUserId(s) {
  return String(s || '').trim().toLowerCase();
}

// "." はメールアドレス内で世代の区切りに使うため不可
export function isValidUserId(id) {
  return /^[a-z0-9_-]{3,20}$/.test(id);
}

export function loginEmail(userId, gen) {
  return `${userId}.${gen}@${LOGIN_DOMAIN}`;
}

export function userIdFromEmail(email) {
  const m = /^([a-z0-9_-]{3,20})\.\d+@(.+)$/.exec(email || '');
  return m && m[2] === LOGIN_DOMAIN ? m[1] : null;
}

// 前回同期した state からの差分。set は追加・変更、del は削除された id
export function diffState(prev, next) {
  const diff = (a, b) => {
    const before = new Map(a.map(x => [x.id, JSON.stringify(x)]));
    const ids = new Set(b.map(x => x.id));
    return {
      set: b.filter(x => before.get(x.id) !== JSON.stringify(x)),
      del: a.filter(x => !ids.has(x.id)).map(x => x.id),
    };
  };
  return { links: diff(prev.links, next.links), folders: diff(prev.folders, next.folders) };
}
