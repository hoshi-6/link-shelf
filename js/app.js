// 画面の描画とイベント
import * as S from './store.js';
import { PALETTE, colorOf, hostOf, normalizeUrl, fetchMeta, screenshotUrl, createCropper } from './cover.js';

const KEY = 'linkShelf.v1';
const PREFS_KEY = 'linkShelf.prefs';
const $ = id => document.getElementById(id);

let state = load();
let prefs = loadPrefs();
let current = folderFromHash();
let query = '';

// ---------- 保存 ----------

function load() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch { /* 使えない環境 */ }
  if (!raw) return S.emptyState();
  try { return S.parseBackup(raw); } catch {
    try { localStorage.setItem(KEY + '.broken', raw); } catch { /* noop */ }
    return S.emptyState();
  }
}

function save() {
  try {
    localStorage.setItem(KEY, S.serialize(state));
    return true;
  } catch {
    toast('保存できませんでした。容量がいっぱいです。画像の表紙を減らしてください');
    return false;
  }
}

// 保存に失敗したら、画面の状態も保存済みの内容に戻す
function commit() {
  if (save()) return true;
  state = load();
  render();
  return false;
}

function loadPrefs() {
  const p = { filter: 'all', sort: 'new' };
  try { Object.assign(p, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* noop */ }
  return p;
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* noop */ }
}

// ---------- 小物 ----------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  return span.firstChild;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

const displayTitle = link => link.title || hostOf(link.url);
const folderName = id => (id ? (state.folders.find(f => f.id === id) || {}).name : null) || '本棚';

// 2 回押すと確定するボタン
function armable(button, label, onConfirm) {
  let timer;
  const reset = () => { clearTimeout(timer); button.classList.remove('armed'); button.textContent = label; };
  button.addEventListener('click', () => {
    if (button.classList.contains('armed')) { reset(); onConfirm(); return; }
    button.classList.add('armed');
    button.textContent = 'もう一度押すと削除';
    timer = setTimeout(reset, 3000);
  });
  return reset;
}

// ---------- 場所(ハッシュ) ----------

function folderFromHash() {
  const m = location.hash.match(/^#\/f\/(.+)$/);
  const id = m ? decodeURIComponent(m[1]) : null;
  return id && state.folders.some(f => f.id === id) ? id : null;
}

// このタブで通ってきた階層の履歴。上に戻るときはブラウザの履歴をさかのぼり、
// スマホの「戻る」で下の階層に戻ってしまわないようにする
const trail = [current];

function go(id) {
  const top = trail.length - 1;
  const k = trail.lastIndexOf(id);
  if (k >= 0 && k < top) { history.go(k - top); return; }
  const hash = id ? '#/f/' + encodeURIComponent(id) : '#/';
  if (location.hash === hash || (!id && !location.hash)) { current = id; render(); }
  else location.hash = hash;
}

addEventListener('hashchange', () => {
  current = folderFromHash();
  const k = trail.lastIndexOf(current);
  if (k >= 0) trail.length = k + 1;
  else trail.push(current);
  render();
  scrollTo(0, 0);
});

// ---------- 表紙 ----------

const enriching = new Set();

// タイトルや自動表紙がまだのリンクを、microlink で補う
function enrich(link) {
  if (enriching.has(link.id)) return;
  enriching.add(link.id);
  fetchMeta(link.url).then(meta => {
    const l = state.links.find(x => x.id === link.id);
    if (!l) return;
    if (!l.cover.autoUrl) l.cover.autoUrl = meta.image || screenshotUrl(l.url);
    if (!l.title) l.title = meta.title || hostOf(l.url);
    save();
    render();
  }).finally(() => enriching.delete(link.id));
}

const needsEnrich = l => !l.title || (l.cover.type === 'auto' && !l.cover.autoUrl);

function colorCover(link) {
  const c = el('div', 'color-cover');
  c.style.setProperty('--c', colorOf(link.cover.color));
  c.append(el('div', 't', displayTitle(link)), el('div', 'd', hostOf(link.url)));
  return c;
}

// container に表紙の中身を入れる。preview のときは自動取得を始めない
function fillCover(container, link, { preview = false } = {}) {
  const { cover } = link;
  if (cover.type === 'image' && cover.image) {
    const img = el('img');
    img.src = cover.image; img.alt = '';
    container.append(img);
    return;
  }
  if (cover.type === 'auto' && cover.autoUrl) {
    // 画像が届くまでは色の表紙を見せておき、読み込めたら上に重ねる
    container.append(colorCover(link));
    const img = el('img', 'pending');
    img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    img.onload = () => img.classList.remove('pending');
    img.onerror = () => {
      const shot = screenshotUrl(link.url);
      if (img.src !== shot && cover.autoUrl !== shot) {
        img.src = shot;
        if (!preview) {
          const l = state.links.find(x => x.id === link.id);
          if (l) { l.cover.autoUrl = shot; save(); }
        }
      } else {
        img.remove();
      }
    };
    img.src = cover.autoUrl;
    container.append(img);
    return;
  }
  container.append(colorCover(link));
  if (cover.type === 'auto' && !preview) container.classList.add('loading-cover');
}

// ---------- 描画 ----------

// 表紙の下の「名前 + ✎」の行
function captionRow(text, editLabel, onEdit) {
  const row = el('div', 'caption-row');
  const edit = el('button', 'edit');
  edit.type = 'button';
  edit.setAttribute('aria-label', editLabel);
  edit.append(icon('edit'));
  edit.addEventListener('click', onEdit);
  row.append(el('div', 'caption', text), edit);
  return row;
}

function linkCard(link, showPath) {
  const card = el('div', 'card');
  const book = el('div', 'book');
  const a = el('a', 'cover');
  a.href = link.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('aria-label', `${displayTitle(link)} を開く`);
  fillCover(a, link);

  const fav = el('button', 'badge-btn fav');
  fav.type = 'button';
  fav.setAttribute('aria-pressed', String(link.fav));
  fav.setAttribute('aria-label', link.fav ? 'お気に入りから外す' : 'お気に入りにする');
  const favIcon = el('span'); favIcon.append(icon('star')); fav.append(favIcon);
  fav.addEventListener('click', () => { S.toggleFav(state, link.id); commit(); render(); });

  book.append(a, fav);
  card.append(book, captionRow(displayTitle(link), `${displayTitle(link)} を編集`, () => openLinkDlg(link)));
  if (showPath) {
    const path = S.pathOf(state, link.folderId).map(f => f.name).join(' › ') || '本棚';
    card.append(el('div', 'sub', '📁 ' + path));
  }
  if (needsEnrich(link)) enrich(link);
  return card;
}

function folderCard(folder) {
  const card = el('div', 'card folder');
  const book = el('div', 'book');
  const box = el('button', 'cover folder-box');
  box.type = 'button';
  box.style.setProperty('--c', colorOf(folder.color));
  box.setAttribute('aria-label', `フォルダー「${folder.name}」を開く`);
  box.addEventListener('click', () => go(folder.id));

  const stack = el('span', 'stack');
  const inner = S.sortLinks(state.links.filter(l => l.folderId === folder.id), prefs.sort).slice(0, 3);
  for (const l of inner) {
    const mini = el('span', 'mini');
    fillCover(mini, l, { preview: true });
    stack.append(mini);
    if (needsEnrich(l)) enrich(l);
  }
  if (!inner.length) { const i = icon('folder'); i.classList.add('empty-icon'); stack.append(i); }

  const c = S.countInside(state, folder.id);
  const parts = [];
  if (c.links) parts.push(`リンク ${c.links}`);
  if (c.folders) parts.push(`フォルダー ${c.folders}`);
  const count = el('span', 'count');
  count.append(icon('folder'), document.createTextNode(parts.join('・') || '空'));

  box.append(el('span', 'tab'), stack, count);

  book.append(box);
  card.append(book, captionRow(folder.name, `フォルダー「${folder.name}」を編集`, () => openFolderDlg(folder)));
  return card;
}

function renderCrumbs() {
  const ol = $('crumbs');
  ol.replaceChildren();
  const path = S.pathOf(state, current);
  if (path.length) {
    const li = el('li');
    const back = el('button', 'back');
    back.type = 'button';
    back.setAttribute('aria-label', '1つ上に戻る');
    back.append(icon('back'));
    back.addEventListener('click', () => go(path.length > 1 ? path[path.length - 2].id : null));
    li.append(back);
    ol.append(li);
  }
  const items = [{ id: null, name: '本棚' }, ...path];
  items.forEach((f, i) => {
    const li = el('li');
    const b = el('button', null, f.name);
    b.type = 'button';
    if (i === items.length - 1) b.setAttribute('aria-current', 'page');
    b.addEventListener('click', () => go(f.id));
    li.append(b);
    ol.append(li);
  });
  // 戻るボタンの後ろには区切りを付けない
  if (path.length) ol.children[1].classList.add('first');
}

function render() {
  renderCrumbs();
  const v = S.view(state, { folderId: current, query, filter: prefs.filter, sort: prefs.sort });
  $('grid').replaceChildren(...v.folders.map(folderCard), ...v.links.map(l => linkCard(l, v.mode === 'flat')));

  const status = $('status');
  if (v.mode === 'flat') {
    const what = query.trim() ? `「${query.trim()}」の検索結果` : 'お気に入り';
    status.textContent = `${what} ${v.links.length}件(すべてのフォルダーから)`;
  } else {
    const parts = [];
    if (v.folders.length) parts.push(`フォルダー ${v.folders.length}`);
    if (v.links.length) parts.push(`リンク ${v.links.length}`);
    status.textContent = parts.join('・');
  }

  const empty = $('empty');
  const isEmpty = !v.folders.length && !v.links.length;
  empty.hidden = !isEmpty;
  if (isEmpty) {
    let title, body, ic = 'shelf';
    if (v.mode === 'flat' && query.trim()) { title = '見つかりませんでした'; body = '名前やURLの一部で探せます。'; ic = 'search'; }
    else if (v.mode === 'flat') { title = 'お気に入りはまだありません'; body = '表紙の右上の ☆ をタップすると、ここに集まります。'; ic = 'star'; }
    else if (current) { title = 'このフォルダーは空です'; body = '右下の ＋ から追加すると、このフォルダーに入ります。'; ic = 'folder'; }
    else { title = '本棚はまだ空です'; body = '右下の ＋ から、リンクやフォルダーを追加しましょう。'; }
    empty.replaceChildren(icon(ic), el('strong', null, title), el('p', null, body));
  }

  for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b.dataset.filter === prefs.filter));
  $('sort').value = prefs.sort;
}

// ---------- ＋メニュー・メニュー ----------

function setFab(open) {
  $('fabMenu').hidden = !open;
  $('scrim').hidden = !open;
  $('fab').setAttribute('aria-expanded', String(open));
  $('fab').setAttribute('aria-label', open ? '閉じる' : '追加');
}
$('fab').addEventListener('click', () => setFab($('fabMenu').hidden));
$('scrim').addEventListener('click', () => setFab(false));
$('addLinkBtn').addEventListener('click', () => { setFab(false); openLinkDlg(null); });
$('addFolderBtn').addEventListener('click', () => { setFab(false); openFolderDlg(null); });

function setMenu(open) {
  $('menuPop').hidden = !open;
  $('menuBtn').setAttribute('aria-expanded', String(open));
}
$('menuBtn').addEventListener('click', e => { e.stopPropagation(); setMenu($('menuPop').hidden); });
document.addEventListener('click', e => { if (!$('menuPop').hidden && !$('menuPop').contains(e.target)) setMenu(false); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  setFab(false);
  setMenu(false);
});

// ---------- 検索・絞り込み・並び替え ----------

$('q').addEventListener('input', e => { query = e.target.value; render(); });
for (const b of document.querySelectorAll('[data-filter]')) {
  b.addEventListener('click', () => { prefs.filter = b.dataset.filter; savePrefs(); render(); });
}
$('sort').addEventListener('change', e => { prefs.sort = e.target.value; savePrefs(); render(); toast(e.target.selectedOptions[0].textContent); });

// ---------- ダイアログ共通 ----------

for (const b of document.querySelectorAll('[data-close]')) {
  b.addEventListener('click', () => b.closest('dialog').close());
}

function fillFolderSelect(select, excludeId, value) {
  select.replaceChildren(...S.folderOptions(state, excludeId).map(o => {
    const opt = el('option', null, o.depth ? '　'.repeat(o.depth - 1) + '📁 ' + o.label : o.label);
    opt.value = o.id ?? '';
    return opt;
  }));
  select.value = value ?? '';
  if (select.selectedIndex < 0) select.value = '';
}

function buildSwatches(container, name, selected, onChange) {
  container.replaceChildren(...PALETTE.map((p, i) => {
    const label = el('label');
    label.title = p.name;
    const input = el('input');
    input.type = 'radio'; input.name = name; input.value = String(i);
    input.checked = i === selected;
    input.setAttribute('aria-label', p.name);
    input.addEventListener('change', () => onChange(i));
    const dot = el('span');
    dot.style.setProperty('--c', p.value);
    label.append(input, dot);
    return label;
  }));
}

// ---------- リンクの編集 ----------

const linkDlg = $('linkDlg');
const lf = {
  editingId: null,
  type: 'auto',
  color: 0,
  image: null, // 既存の画像(dataURL)
  cropper: null,
  autoUrl: null,
  origUrl: null,
};

function draftLink() {
  return {
    id: lf.editingId,
    url: normalizeUrl($('lUrl').value) || 'https://',
    title: $('lTitle').value.trim(),
    cover: { type: lf.type, color: lf.color, autoUrl: normalizeUrl($('lUrl').value) === lf.origUrl ? lf.autoUrl : undefined },
  };
}

function updateLinkPreview() {
  const prev = $('lPreview');
  const box = el('div', 'cover');
  const d = draftLink();
  if (!d.title) d.title = $('lUrl').value.trim() ? '' : '名前';
  fillCover(box, d, { preview: true });
  prev.replaceChildren(box);
}

function setCoverType(type) {
  lf.type = type;
  for (const r of linkDlg.querySelectorAll('input[name=coverType]')) r.checked = r.value === type;
  $('lColorArea').hidden = type === 'image';
  $('lImageArea').hidden = type !== 'image';
  $('lColorHint').hidden = type !== 'auto';
  if (type === 'image' && lf.cropper) requestAnimationFrame(() => lf.cropper.refit());
  updateLinkPreview();
}

function resetCropper() {
  if (lf.cropper) lf.cropper.destroy();
  lf.cropper = null;
  $('zoomRow').hidden = true;
  $('lFile').value = '';
  const frame = $('cropFrame');
  frame.replaceChildren();
  if (lf.image) {
    const img = el('img');
    img.src = lf.image; img.alt = '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
    frame.append(img);
  }
  $('pickLabel').textContent = lf.image ? '画像を変える' : '画像を選ぶ';
  $('cropHint').hidden = !lf.image;
  $('cropHint').textContent = lf.image ? '今の表紙です' : '';
}

let resetLinkDelete = () => {};

function openLinkDlg(link) {
  lf.editingId = link ? link.id : null;
  lf.type = link ? link.cover.type : 'auto';
  lf.color = link ? link.cover.color : state.links.length % PALETTE.length;
  lf.image = link && link.cover.image ? link.cover.image : null;
  lf.autoUrl = link ? link.cover.autoUrl : null;
  lf.origUrl = link ? link.url : null;
  $('linkDlgTitle').textContent = link ? 'リンクを編集' : 'リンクを追加';
  $('lUrl').value = link ? link.url : '';
  $('lTitle').value = link ? link.title : '';
  fillFolderSelect($('lFolder'), null, link ? link.folderId : current);
  buildSwatches($('lSwatches'), 'lColor', lf.color, i => { lf.color = i; updateLinkPreview(); });
  $('lDelete').hidden = !link;
  resetLinkDelete();
  resetCropper();
  setCoverType(lf.type);
  linkDlg.showModal();
  if (!link) $('lUrl').focus();
}

for (const r of linkDlg.querySelectorAll('input[name=coverType]')) {
  r.addEventListener('change', () => setCoverType(r.value));
}
$('lUrl').addEventListener('input', updateLinkPreview);
$('lTitle').addEventListener('input', updateLinkPreview);

$('lFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const c = await createCropper($('cropFrame'), $('cropZoom'), file);
    if (lf.cropper) lf.cropper.destroy();
    lf.cropper = c;
    $('zoomRow').hidden = false;
    $('pickLabel').textContent = '画像を変える';
    $('cropHint').hidden = false;
    $('cropHint').textContent = 'ドラッグで位置を調整できます';
  } catch {
    toast('画像を読み込めませんでした');
  }
});

$('linkForm').addEventListener('submit', e => {
  e.preventDefault();
  const url = normalizeUrl($('lUrl').value);
  let ok = false;
  try { ok = /^https?:$/.test(new URL(url).protocol) && url.length > 8; } catch { /* invalid */ }
  if (!ok) { toast('URLを確認してください'); $('lUrl').focus(); return; }

  const cover = { type: lf.type, color: lf.color };
  if (lf.type === 'image') {
    if (lf.cropper) cover.image = lf.cropper.toDataUrl();
    else if (lf.image) cover.image = lf.image;
    else { toast('表紙にする画像を選んでください'); return; }
  }
  if (url === lf.origUrl && lf.autoUrl) cover.autoUrl = lf.autoUrl;

  const data = { url, title: $('lTitle').value.trim(), folderId: $('lFolder').value || null, cover };
  const isNew = !lf.editingId;
  if (isNew) S.addLink(state, data);
  else S.updateLink(state, lf.editingId, data);
  if (!commit()) return;
  linkDlg.close();
  render();
  if (isNew) toast(data.folderId !== current ? `「${folderName(data.folderId)}」に追加しました` : '追加しました');
  else toast('保存しました');
});

resetLinkDelete = armable($('lDelete'), '削除', () => {
  S.deleteLink(state, lf.editingId);
  if (!commit()) return;
  linkDlg.close();
  render();
  toast('削除しました');
});

linkDlg.addEventListener('close', () => {
  if (lf.cropper) { lf.cropper.destroy(); lf.cropper = null; }
  resetLinkDelete();
});

// ---------- フォルダーの編集 ----------

const folderDlg = $('folderDlg');
const ff = { editingId: null, color: 0 };
let resetFolderDelete = () => {};

function openFolderDlg(folder) {
  ff.editingId = folder ? folder.id : null;
  ff.color = folder ? folder.color : (state.folders.length + 3) % PALETTE.length;
  $('folderDlgTitle').textContent = folder ? 'フォルダーを編集' : 'フォルダーを作成';
  $('fName').value = folder ? folder.name : '';
  buildSwatches($('fSwatches'), 'fColor', ff.color, i => { ff.color = i; });
  fillFolderSelect($('fParent'), folder ? folder.id : null, folder ? folder.parentId : current);
  $('fDelete').hidden = !folder;
  resetFolderDelete();
  folderDlg.showModal();
  if (!folder) $('fName').focus();
}

$('folderForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('fName').value.trim();
  if (!name) { toast('フォルダーの名前を入れてください'); $('fName').focus(); return; }
  const parentId = $('fParent').value || null;
  if (ff.editingId) {
    try { S.updateFolder(state, ff.editingId, { name, color: ff.color, parentId }); }
    catch { toast('その場所には移動できません'); return; }
  } else {
    S.addFolder(state, { name, color: ff.color, parentId });
  }
  if (!commit()) return;
  folderDlg.close();
  render();
  toast(ff.editingId ? '保存しました' : (parentId !== current ? `「${folderName(parentId)}」に作成しました` : 'フォルダーを作成しました'));
});

function removeFolder(id, mode) {
  const folder = state.folders.find(f => f.id === id);
  if (!folder) return;
  S.deleteFolder(state, id, mode);
  if (!commit()) return;
  folderDlg.close();
  $('delDlg').close();
  toast('削除しました');
  if (current && !state.folders.some(f => f.id === current)) go(folder.parentId);
  else render();
}

resetFolderDelete = armable($('fDelete'), '削除', () => removeFolder(ff.editingId, 'lift'));

// 中身があるときは、2 回押しの代わりに選択ダイアログを出す
$('fDelete').addEventListener('click', e => {
  const c = S.countDeep(state, ff.editingId);
  if (!c.links && !c.folders) return;
  e.stopImmediatePropagation();
  const folder = state.folders.find(f => f.id === ff.editingId);
  const parts = [];
  if (c.links) parts.push(`リンク ${c.links}件`);
  if (c.folders) parts.push(`フォルダー ${c.folders}件`);
  const what = parts.join('・');
  $('delText').textContent = `「${folder.name}」には ${what} が入っています(中のフォルダーの分も含みます)。`;
  $('delLiftSub').textContent = `フォルダーだけを削除し、中身は「${folderName(folder.parentId)}」に移します`;
  $('delAllSub').textContent = `${what} もまとめて削除します。元に戻せません`;
  $('delDlg').showModal();
}, { capture: true });

$('delLift').addEventListener('click', () => removeFolder(ff.editingId, 'lift'));
$('delAll').addEventListener('click', () => removeFolder(ff.editingId, 'all'));

folderDlg.addEventListener('close', () => resetFolderDelete());

// ---------- バックアップ ----------

$('backupBtn').addEventListener('click', () => {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const blob = new Blob([S.serialize(state)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `link-shelf-backup-${ymd}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setMenu(false);
  toast('バックアップを保存しました');
});

$('restoreInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  setMenu(false);
  if (!file) return;
  let next;
  try { next = S.parseBackup(await file.text()); } catch {
    toast('読み込めませんでした。バックアップのファイルか確認してください');
    return;
  }
  const ok = confirm(`リンク ${next.links.length}件・フォルダー ${next.folders.length}件 を読み込みます。\n今のデータは置き換えられます。よろしいですか?`);
  if (!ok) return;
  const prev = state;
  state = next;
  if (!save()) { state = prev; return; }
  toast('復元しました');
  go(null);
});

// ---------- 起動 ----------

render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* オフライン対応なしで動かす */ });
}
