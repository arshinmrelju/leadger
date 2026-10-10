/* =========================================================
   TrustX Ledger — Service worker
   -----------------------------------------------------------------
   Makes the installed desktop app start with no network at all.

   WHY THE APP NEEDS THIS
   Firestore and the Realtime Database both persist locally, so the SHOP'S
   DATA survives an outage already. But the Firebase SDK itself is imported
   from a CDN at boot (see the import map in each page). With no connection
   that import fails, the app never starts, and the offline data sitting in
   IndexedDB is unreachable. Caching the SDK is therefore not a nice-to-have
   here; without it "offline-first" is only true once you are already running.

   THE ONE RULE THAT MATTERS: NEVER TOUCH THE DATABASE TRAFFIC
   Every read and write this app makes goes over the network to Firebase, and
   the money rules live in firestore.rules. A service worker that put a
   cache in front of that would be able to invent a read result, replay a
   write, or hand a revoked browser a session it no longer has. So the rule
   is an ALLOWLIST, not a blocklist: this worker only ever responds to its
   own origin and to two font/static CDNs, and calls respondWith() on
   nothing else. Anything not named — firestore.googleapis.com,
   *.firebaseio.com, identitytoolkit, securetoken, accounts.google.com,
   every future Firebase endpoint, and anything else invented later — is
   passed straight through untouched by returning early.

   A blocklist was rejected deliberately. It would have to guess at every
   host Firebase might use, and would fail open on any host nobody thought of.

   HOW UPDATES WORK, AND WHY THEY ASK
   A new deploy changes this file's contents and therefore CACHE_VERSION. The
   new worker installs and sits in `waiting` — it does NOT skipWaiting on
   its own. Swapping code out from under a shopkeeper mid-sale would leave
   the page holding one version of the write path while the rules on the
   server are another, which is exactly the class of bug this app's rules
   exist to prevent. Instead js/pwa.js surfaces an "Update ready" prompt and
   reloads on the shopkeeper's word.
   ========================================================= */

/** Bump to invalidate every cached file on the next activate. */
const CACHE_VERSION = "v14";

const SHELL_CACHE = `trustx-shell-${CACHE_VERSION}`;
const VENDOR_CACHE = `trustx-vendor-${CACHE_VERSION}`;

/**
 * The Firebase SDK version, pinned to match the import maps in the pages.
 *
 * This is duplicated on purpose — a service worker cannot read an HTML file's
 * import map at install time without fetching it — which makes drift the
 * obvious failure mode: bump the pages to a new SDK, and offline boot starts
 * loading a version the worker never cached. So tests/module-graph.mjs
 * asserts these match every import map in the repo. If you bump one, bump
 * the other.
 */
const FIREBASE_VERSION = "12.18.0";

const FIREBASE_SDK = [
  "https://www.gstatic.com/firebasejs/" + FIREBASE_VERSION + "/firebase-app.js",
  "https://www.gstatic.com/firebasejs/" + FIREBASE_VERSION + "/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/" + FIREBASE_VERSION + "/firebase-firestore.js",
  "https://www.gstatic.com/firebasejs/" + FIREBASE_VERSION + "/firebase-database.js",
];

/**
 * The app itself. Every page and module, listed explicitly.
 *
 * A build step would generate this, but this project deliberately has none:
 * it is a static site that is served straight from disk. That makes an
 * incomplete list the real risk — a page that works online and 404s offline.
 * tests/module-graph.mjs therefore cross-checks this list against the files
 * actually in js/ and css/, so a new module cannot be added without either
 * being cached or being deliberately excluded.
 */
const SHELL_FILES = [
  "./",
  "index.html",
  "login.html",
  "dashboard.html",
  "transactions.html",
  "calendar.html",
  "ledger.html",
  "admin.html",
  "admin-login.html",
  "offline.html",
  "manifest.webmanifest",
  "manifest-admin.webmanifest",

  "css/style.css",
  "css/forms.css",
  "css/responsive.css",
  "css/mobile.css",
  "css/dashboard.css",
  "css/transactions.css",
  "css/ledger.css",
  "css/calendar.css",
  "css/admin.css",

  "js/app.js",
  "js/admin.js",
  "js/ai-config.js",
  "js/auth.js",
  "js/calendar.js",
  "js/day-audit.js",
  "js/day-heads.js",
  "js/day-ledger.js",
  "js/firebase.js",
  "js/image-receipt.js",
  "js/ledger.js",
  "js/pwa.js",
  "js/quota.js",
  "js/read-cache.js",
  "js/receipt-items.js",
  "js/sale-form.js",
  "js/service-catalog.js",
  "js/service-picker.js",
  "js/shell.js",
  "js/txn-actions.js",
  "js/utils.js",

  "assets/logo.svg",
  "assets/favicon.svg",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/icon-maskable-512.png",
  "assets/logo-owner.svg",
  "assets/favicon-owner.svg",
  "assets/icon-owner-192.png",
  "assets/icon-owner-512.png",
  "assets/icon-maskable-owner-512.png",
  "assets/coin-gold.svg",
  "assets/coin-silver.svg",
  "assets/cha-ching.mp3",
];

/**
 * Cross-origin hosts this worker will cache from. Everything else goes
 * straight to the network.
 */
const VENDOR_HOSTS = new Set([
  "www.gstatic.com",       // the Firebase SDK
  "fonts.googleapis.com",  // the Nunito stylesheet
  "fonts.gstatic.com",     // the Nunito font files
]);

/**
 * Paths under our own origin that must never be cached, even though they
 * look like ordinary static files.
 *
 * `tools/` is Node scripts, and it is here as well as in firebase.json's
 * deploy ignore because the two fail independently: a developer who forgets
 * the ignore rule would otherwise let the worker cache a maintenance script
 * that reads a service-account key.
 */
const NEVER_CACHE = [
  "/tools/",
  "/sa.json",
  "/service-account.json",
  "/firebase-debug.log",
  "/database-debug.log",
  "/.firebase/",
];

/* ------------------------------------------------------------------
   Install / activate
   ------------------------------------------------------------------ */

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      const vendor = await caches.open(VENDOR_CACHE);

      /* Added one at a time and failures tolerated: a single 404 must not
         leave the shop with NO service worker and therefore no offline
         support at all, which is the opposite of the intent. Whatever did
         cache is still worth having, and the next deploy retries the rest. */
      await Promise.all([
        ...SHELL_FILES.map(async (file) => {
          try {
            await shell.add(new Request(file, { cache: "reload" }));
          } catch (err) {
            console.warn("[trustx-sw] shell file not cached:", file, err);
          }
        }),
        ...FIREBASE_SDK.map(async (url) => {
          try {
            await vendor.add(new Request(url, { mode: "cors", cache: "reload" }));
          } catch (err) {
            console.warn("[trustx-sw] SDK file not cached:", url, err);
          }
        }),
      ]);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      /* Drop every cache that is not one of ours at this version. This is
         what makes a deploy actually take effect. */
      const keep = new Set([SHELL_CACHE, VENDOR_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)),
      );

      /* New tabs should be controlled immediately — otherwise a user who
         has the old worker open keeps getting the old behaviour until every
         other tab closes, which on a single-window desktop app means never. */
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {
          /* Not supported here; navigations just take the normal path. */
        });
      }

      await self.clients.claim();
    })(),
  );
});

/* ------------------------------------------------------------------
   Message channel
   ------------------------------------------------------------------ */

self.addEventListener("message", (event) => {
  /* The page sends this only after the shopkeeper has agreed to reload. */
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

/* ------------------------------------------------------------------
   Fetch
   ------------------------------------------------------------------ */

/** True when this worker refuses to have anything to do with a request. */
function isUntouched(request, url) {
  /* Only GET is cacheable at all. A write is a write. */
  if (request.method !== "GET") return true;

  /* Not a URL we recognise as ours or as an allowed CDN. This single line
     is what keeps Firestore, the Realtime Database, Firebase Auth and the
     Google sign-in popup out of the cache. */
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !VENDOR_HOSTS.has(url.hostname)) return true;

  /* Same-origin paths that must never be cached. */
  if (sameOrigin && NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix))) {
    return true;
  }

  /* The worker itself: always live, so a deploy is never shadowed by a
     cached copy of the worker. */
  if (sameOrigin && url.pathname.endsWith("/sw.js")) return true;

  return false;
}

/**
 * Cache-first, revalidating in the background.
 *
 * Used for the app shell and the pinned SDK. Both are version-addressed by
 * CACHE_VERSION and by the pinned Firebase version respectively, so the worst
 * a stale copy can be is one deploy old — and the update prompt exists to
 * make even that visible rather than silent.
 */
async function cacheFirst(request) {
  const cache = await caches.open(request.url.startsWith(self.location.origin) ? SHELL_CACHE : VENDOR_CACHE);
  const cached = await cache.match(request, { ignoreVary: true });

  if (cached) {
    /* Refresh behind the page. Not awaited: the screen should paint now. */
    fetchAndStore(request, cache);
    return cached;
  }

  const response = await fetch(request);
  /* Only a real, complete 200 is worth keeping — never an opaque response,
     a 206, or an error page, which would then be served as if it were the
     file. */
  if (response && response.status === 200 && response.type !== "opaque") {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function fetchAndStore(request, cache) {
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type !== "opaque") {
      await cache.put(request, response);
    }
  } catch {
    /* Offline. The cached copy stays as it was, which is the point. */
  }
}

/**
 * Navigations.
 *
 * Cache-first so launching the installed app is instant and works with no
 * connection. A network failure falls back to the cached page, and a request
 * for a page we have never cached falls back to the offline notice rather
 * than the browser's error page — which in a standalone window means a blank
 * white void and no way back.
 */
async function handleNavigation(event) {
  try {
    /* When navigation preload is available the browser has already started
       fetching the next page while it was still deciding to navigate, so use
       that response and skip a second round trip. */
    const preload = await event.preloadResponse;
    if (preload) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(event.request, preload.clone()).catch(() => {});
      return preload;
    }
    return await cacheFirst(event.request);
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    const fallback = await cache.match(event.request, { ignoreVary: true });
    if (fallback) return fallback;
    const offline = await cache.match("offline.html", { ignoreVary: true });
    if (offline) return offline;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  /* The safety gate: everything this worker will not touch returns here,
     before respondWith, and is handled entirely by the browser. */
  if (isUntouched(request, url)) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(event));
    return;
  }

  event.respondWith(cacheFirst(request));
});