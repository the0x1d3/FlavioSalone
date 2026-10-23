// Offline support: pages and assets are network-first with a cache fallback, so updates arrive at once when online.
// The API is never cached here: the admin app keeps its own data copy and change queue (see offline.js).
const CACHE = 'salone-pro-v7';
// Admin sections share one page (see vercel.json rewrites): offline they all open the cached "/".
const SECTIONS = /^\/(agenda|listino|clienti|magazzino|prenotazione-web|privacy|impostazioni)\/?$/;
const SHELL = ['/', '/base.css', '/theme.js', '/common.js', '/offline.js', '/history.js', '/csv.js', '/admin.css', '/js/app.js', '/js/api-sync.js', '/js/novita.js', '/js/agenda.js', '/js/listino.js', '/js/clienti.js', '/js/magazzino.js', '/js/impostazioni.js', '/js/avvio.js', '/vendor/phosphor.css', '/vendor/phosphor.woff2', '/vendor/geist.woff2', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    })
    .catch(() => caches.match(SECTIONS.test(url.pathname) ? '/' : e.request, { ignoreSearch: true }).then((hit) => hit || Response.error())));
});

// Push from the server (new online booking, morning summary): shown even when the app is closed or the phone locked.
self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || 'Salone PRO', {
    body: d.body || '', tag: d.tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/' },
  }));
});

// Tapping the notification opens the app on the right page, reusing a window that is already open.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => w.url.startsWith(self.location.origin));
    return win ? win.navigate(url).then((w) => (w || win).focus()) : self.clients.openWindow(url);
  }));
});
