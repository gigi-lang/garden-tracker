/* Garden Tracker service worker.

   THERE IS NO VERSION IN THIS FILE, and that is the point. The first version of
   this worker took the app version in a query string (`sw.js?v=v0.51`) so the
   cache could be named after the release. It was wrong in a way that only shows
   up on the SECOND release: a page already open registers the URL carrying ITS
   OWN version, so re-checking only ever re-fetches that same URL, which never
   changes. No update would ever be found, and because navigations are served
   from cache the new index.html would never arrive either. The app would have
   pinned itself to whatever release first installed it, permanently.

   What it does instead: serve the cached page immediately, then quietly re-fetch
   index.html in the background and compare it byte for byte with the copy in the
   cache. Different bytes mean a new release: refresh the whole shell and tell the
   page, which raises the "new version is ready" bar. The gardener presses Reload
   when it suits them.

   Two things fall out of that. Releases stay index.html-only, because this file
   never has to change. And the one version literal in the project is still
   APP_VERSION in index.html - nothing here shadows it. */

const CACHE = 'garden-tracker-shell';
const DOC = './index.html';

const SHELL = [
  './',
  DOC,
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './fraunces-latin-400-normal.woff2',
  './fraunces-latin-500-normal.woff2',
  './fraunces-latin-600-normal.woff2',
  './inter-latin-400-normal.woff2',
  './inter-latin-500-normal.woff2',
  './inter-latin-600-normal.woff2'
];

/* one at a time, never addAll: addAll is all-or-nothing, so a single typo in an
   icon name would silently leave the app with no offline copy at all */
function fillShell(cache, bust) {
  return Promise.all(SHELL.map(function (url) {
    return fetch(url, bust ? { cache: 'reload' } : undefined)
      .then(function (res) { if (res && res.ok) return cache.put(url, res); })
      .catch(function (err) { console.warn('[sw] could not cache', url, err); });
  }));
}

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return fillShell(c, false); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        // clears the per-release caches the first design left behind
        if (k !== CACHE && k.indexOf('garden-tracker') === 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function notify(type) {
  return self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function (cs) {
    cs.forEach(function (c) { c.postMessage({ type: type }); });
  });
}

/* Re-fetch the page past the HTTP cache and compare it with what we hold. Only a
   real difference counts as a release - not a timestamp, not a header. */
let checking = false;
function checkForUpdate() {
  if (checking) return Promise.resolve();
  checking = true;
  return caches.open(CACHE).then(function (c) {
    return Promise.all([c.match(DOC), fetch(DOC, { cache: 'reload' })]).then(function (r) {
      const cached = r[0], fresh = r[1];
      if (!fresh || !fresh.ok) return;
      if (!cached) return c.put(DOC, fresh.clone()); // first run: nothing to compare against
      return Promise.all([cached.text(), fresh.clone().text()]).then(function (t) {
        if (t[0] === t[1]) return;                   // same release, nothing to say
        return fillShell(c, true).then(function () { return notify('update-ready'); });
      });
    });
  }).catch(function () { /* offline: nothing to check, and that is fine */ })
    .then(function () { checking = false; });
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // nothing cross-origin is left

  if (req.mode === 'navigate') {
    /* cache first, so it opens instantly and with no signal at all; the check for
       a newer release rides along afterwards and never delays the paint */
    e.respondWith(
      caches.match(DOC).then(function (hit) { return hit || fetch(req); })
    );
    e.waitUntil(checkForUpdate());
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});

self.addEventListener('message', function (e) {
  // the page asks for a check when it comes back to the foreground
  if (e.data && e.data.type === 'check') e.waitUntil(checkForUpdate());
});
