// Service Worker: recibe las notificaciones push aunque la app esté cerrada
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'ALERTA', body: 'Abra la aplicación' }; }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    tag: d.tag,
    renotify: true,
    requireInteraction: true,          // la notificación no desaparece sola
    vibrate: [600, 200, 600, 200, 600],
    icon: '/icono-192.png',
    badge: '/favicon.png'
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    const w = ws.find(x => new URL(x.url).pathname === '/');
    return w ? w.focus() : clients.openWindow('/');
  }));
});
