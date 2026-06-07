/* Walls Service Worker
 * Minimal SW for PWA installability + Web Push.
 * NOTE: We intentionally do NOT register a 'fetch' handler.
 * Chrome logs "Fetch event handler is recognized as no-op" when a SW
 * registers a fetch listener that doesn't actually intercept anything.
 * Omitting the listener removes that warning and lets the browser
 * use its normal network path with zero overhead.
 */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/* Web Push: OS-level notifications */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { title: 'Walls', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Walls';
  const options = {
    body: data.body || '',
    icon: data.icon || './icon192.png',
    badge: data.badge || './icon192.png',
    data: data.data || { url: data.url || '/' },
    tag: data.tag || undefined,
    renotify: !!data.renotify,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      try {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) { try { await client.navigate(target); } catch (_) {} }
          return;
        }
      } catch (_) {}
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

/* No 'fetch' handler on purpose. */
