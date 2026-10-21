/* Yapper service worker: app-shell caching, emoji caching, and push notifications. */
const VERSION = 'yapper-v1';
const SHELL = [
  '/', '/css/app.css', '/manifest.webmanifest', '/favicon.png', '/icons/logo.png', '/icons/icon-192.png', '/icons/badge-96.png',
  '/fonts/inter-latin-wght-normal.woff2', '/fonts/inter-latin-ext-wght-normal.woff2', '/emoji/data.json',
  '/js/main.js', '/js/api.js', '/js/dom.js', '/js/icons.js', '/js/store.js', '/js/router.js', '/js/realtime.js', '/js/emoji.js',
  '/js/markdown.js', '/js/notifications.js', '/js/appearance.js', '/js/auth.js',
  '/js/ui/app.js', '/js/ui/chat.js', '/js/ui/components.js', '/js/ui/layers.js', '/js/ui/picker.js', '/js/ui/profile.js',
  '/js/ui/friends.js', '/js/ui/settings.js', '/js/ui/server-settings.js', '/js/ui/channel-settings.js', '/js/ui/voice.js',
  '/js/ui/panels.js', '/js/ui/poll.js', '/js/ui/perms.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== 'yapper-emoji') await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  // Emoji images never change: cache-first.
  if (url.pathname.startsWith('/emoji/3d/')) {
    e.respondWith(caches.open('yapper-emoji').then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // App navigation: network first, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }

  // Static assets: stale-while-revalidate.
  if (/^\/(js|css|fonts|icons)\/|^\/(favicon\.png|manifest\.webmanifest|emoji\/data\.json)$/.test(url.pathname)) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Yapper', body: e.data?.text() }; }
  e.waitUntil((async () => {
    // Skip if a Yapper window is focused (the app shows its own in-app cues).
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.focused && w.visibilityState === 'visible') && data.type !== 'call') return;
    await self.registration.showNotification(data.title || 'Yapper', {
      body: data.body || '',
      icon: data.icon || '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag,
      renotify: true,
      requireInteraction: data.type === 'call',
      vibrate: data.type === 'call' ? [300, 200, 300, 200, 300] : [80, 40, 80],
      data: { url: data.url || '/channels/@me' },
    });
    if ('setAppBadge' in navigator && data.mentioned) navigator.setAppBadge().catch(() => {});
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/channels/@me';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === location.origin) {
        await w.focus();
        w.postMessage({ type: 'navigate', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

self.addEventListener('pushsubscriptionchange', (e) => {
  // The page re-syncs subscriptions on next load; nothing reliable to do here without auth.
  e.waitUntil(Promise.resolve());
});
