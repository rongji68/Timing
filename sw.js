const CACHE = 'tsdq-1.8.1-202611081120';   // 由 tools/发布新版本.py 自动更新
const SHELL = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'js/app.js', 'js/store.js', 'js/sync.js', 'js/crypto.js', 'js/stats.js', 'js/charts.js', 'js/timeline.js', 'js/importer.js',
  'js/ui.js', 'js/search.js', 'js/reminders.js', 'js/version.js'];
// 离线缓存策略：先用缓存（离线或网络慢时也能立即打开），同时在后台从网络取最新文件更新缓存，下次打开生效。
// 发布新版本时 CACHE 名称会变，浏览器会安装新的 Service Worker 并重新下载全部文件。同步接口（/api/）从不缓存。
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/api/')) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const cached = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    if (cached) { e.waitUntil(net); return cached; }
    const r = await net;
    if (r) return r;
    return (e.request.mode === 'navigate' && await c.match('index.html')) || Response.error();
  }));
});
