// アプリのファイルだけをキャッシュする(ログインと本棚の表示には通信が必要)。
// 更新がすぐ反映されるよう、通信できるときはネットワークを優先する。
const CACHE = 'link-shelf-v3';
const FILES = [
  './',
  'index.html',
  'js/app.js',
  'js/store.js',
  'js/cover.js',
  'js/cloud.js',
  'js/idle.js',
  'js/firebase-config.js',
  'manifest.json',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 外部サイト(表紙の画像など)には手を出さない
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // ブラウザのキャッシュ(GitHub Pages は 10 分)に古いファイルが残っていても、毎回サーバーに更新を確かめる
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./')))
  );
});
