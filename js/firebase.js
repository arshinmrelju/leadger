/* =========================================================
   TrustX Ledger — Firebase bootstrap
   -----------------------------------------------------------------
   SECURITY NOTE
   The object below is the *public* Firebase client configuration.
   Firebase client config is NOT a secret — it is shipped to every
   browser that opens the app (it only identifies the project). All
   real security lives in `firestore.rules`, `database.rules.json`
   and Firebase Authentication.
   NEVER paste service-account / admin private keys here.

   HOW TO CONNECT A REAL PROJECT
   1. Create a Firebase project and register a web app in the
      Firebase console (Project settings -> Your apps -> Web app).
   2. Copy the `firebaseConfig` values from the console and replace
      every `YOUR_*` value below.
   3. Enable the sign-in method the app needs:
      **Authentication -> Sign-in method -> Google**.
   4. Deploy both rule sets and the Firestore indexes
      (`firebase deploy --only firestore,database`).

   ONE PROJECT, TWO DATABASES
   Firestore holds the transactions and the service catalog:
     dayHeads/{dateKey}                     one document per business day
     dayHeads/{dateKey}/transactions/{id}   that day's sales
     services/{serviceId}                   the quick-service catalog
   Realtime Database holds everything else — the shop identity (settings),
   the Google-account allowlist, the trusted-device registry (devices,
   enrollments), and expenses. It was chosen for them because its rules
   language can compare a submitted secret against a server-held one —
   which is what the enrollment check needs.
   ========================================================= */

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD8IOVbktIMNhuziVf40WqhRMpp3pNu04w",
  authDomain: "trustxplpy.firebaseapp.com",
  projectId: "trustxplpy",
  /* VERIFY THIS against Project settings -> Your apps -> Web app ->
     Realtime Database. Newer projects use the "-default-rtdb" form,
     older ones use "firebaseio.com" directly. Realtime Database refuses
     to guess, so a wrong value here breaks the catalog, the devices
     registry and expenses — everything except the ledger itself. */
  databaseURL: "https://trustxplpy-default-rtdb.firebaseio.com",
  storageBucket: "trustxplpy.firebasestorage.app",
  messagingSenderId: "35151713005",
  appId: "1:35151713005:web:4450046d9fc20e133372e4",
  measurementId: "G-PDBHSYYFXQ",
};

const PLACEHOLDER_TOKENS = ["YOUR_"];

/**
 * True when the developer replaced the placeholders with a real
 * Firebase web app configuration. Until then the app runs in
 * "setup needed" mode and never touches the network.
 */
export function isConfigured() {
  const c = FIREBASE_CONFIG;
  const hasValue = (v) => typeof v === "string" && v.trim() !== "" && !PLACEHOLDER_TOKENS.some((t) => v.includes(t));
  return Boolean(c && hasValue(c.apiKey) && hasValue(c.projectId) && hasValue(c.appId));
}

let firebridgePromise = null;

/**
 * Initialize (idempotent) Firebase App + Auth + Firestore + RTDB.
 * The SDK is loaded lazily from the pinned CDN (`import map` in the
 * HTML pages) so the app shell never depends on the network to boot.
 *
 * Offline-first: both databases are configured with local persistence
 * (multi-tab for Firestore), so data keeps working during temporary
 * internet loss and writes sync automatically when connectivity returns.
 *
 * @returns {Promise<{app, auth, db, rtdb, googleProvider, authMod, firestore, rtdbMod} | null>}
 */
export function initFirebase() {
  if (!isConfigured()) return Promise.resolve(null);
  if (firebridgePromise) return firebridgePromise;

  firebridgePromise = (async () => {
    const [{ initializeApp }, authMod, firestoreMod, rtdbMod] = await Promise.all([
      import("firebase/app"),
      import("firebase/auth"),
      import("firebase/firestore"),
      import("firebase/database"),
    ]);

    const app = initializeApp(FIREBASE_CONFIG);

    const auth = authMod.getAuth(app);
    try {
      await authMod.setPersistence(auth, authMod.browserLocalPersistence);
    } catch (err) {
      /* Local persistence is a convenience; failure is not fatal. */
      console.warn("[trustx-ledger] Auth persistence unavailable:", err);
    }

    let db;
    try {
      db = firestoreMod.initializeFirestore(app, {
        localCache: firestoreMod.persistentLocalCache({
          tabManager: firestoreMod.persistentMultipleTabManager(),
        }),
      });
    } catch (err) {
      /* e.g. private-browsing mode without IndexedDB support. */
      console.warn("[trustx-ledger] Firestore IndexedDB persistence unavailable, using in-memory cache:", err);
      db = firestoreMod.getFirestore(app);
    }

    /* Realtime Database caches in memory by default and persists to
       IndexedDB when it can, with no configuration to get wrong. It is
       resolved defensively: Firestore is the money path and must still
       boot if a misconfigured databaseURL takes the catalog, the
       devices registry and expenses down with it. Callers check `rtdb`
       and surface a clear message instead of failing obscurely. */
    let rtdb = null;
    try {
      rtdb = rtdbMod.getDatabase(app);
    } catch (err) {
      console.error(
        "[trustx-ledger] Realtime Database unavailable — check databaseURL in js/firebase.js:",
        err
      );
    }

    return {
      app,
      auth,
      db,
      rtdb,
      googleProvider: new authMod.GoogleAuthProvider(),
      authMod,
      firestore: firestoreMod,
      rtdbMod,
    };
  })();

  firebridgePromise.catch(() => {
    /* Allow retry on a later page load. */
    firebridgePromise = null;
  });

  return firebridgePromise;
}

/**
 * Returns the initialized Firebase bridge (same promise as initFirebase).
 * Resolves to null when the Firebase config has not been provided yet.
 */
export function getFirebridge() {
  return firebridgePromise || initFirebase();
}

/* Warm up now when a real config is present; no-op otherwise. */
initFirebase().catch((err) => {
  console.warn("[trustx-ledger] Firebase init deferred:", err);
});