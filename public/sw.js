'use strict';
/*
 * Service worker: caches only the PUBLIC app shell (HTML, CSS, JS, icons) so the app opens on poor connections.
 * It never caches /api/ responses or files, so one student's data is never kept for another on a shared device.
 */
const CACHE = 'ges-shell-v1';
const SHELL = ['/', '/css/app.css', '/js/core.js', '/js/public.js', '/js/student.js', '/js/social.js', '/js/staff.js', '/js/admin.js', '/js/boot.js', '/icon.svg', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // network only
  e.respondWith(fetch(req).then((res) => { if (res.ok && SHELL.includes(url.pathname)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
    .catch(() => caches.match(req).then((hit) => hit || caches.match('/'))));
});
