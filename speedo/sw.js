/* Cache-first service worker: once installed the app runs with no signal at all,
   which is the normal condition a mile offshore. */
var CACHE = 'boat-speedo-v2';

var ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './sun.js',
  './trips.js',
  './tides.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-512.png'
];

/* Tide predictions come from a third-party API and must never be served from the
   app shell cache — they are cached deliberately in localStorage instead, with a
   timestamp, so the UI can say how old they are. */
function isTideRequest(url) {
  return /tidesandcurrents|datagetter/.test(url);
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  if (isTideRequest(e.request.url)) return;    // straight to the network, never cached here

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) {
        // Serve instantly, then quietly refresh the copy for next launch.
        fetch(e.request).then(function (res) {
          if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(e.request, res); });
        }).catch(function () {});
        return hit;
      }
      return fetch(e.request).catch(function () { return caches.match('./index.html'); });
    })
  );
});
