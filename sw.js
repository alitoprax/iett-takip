self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    return self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    // Pass-through for now, just to satisfy PWA requirements
    e.respondWith(fetch(e.request));
});
