/* =========================================================
   SEVA LEDGER — Firebase bootstrap
   -----------------------------------------------------------------
   SECURITY NOTE
   The object below is the *public* Firebase client configuration.
   Firebase client config is NOT a secret — it is shipped to every
   browser that opens the app (it only identifies the project). All
   real security lives in `firestore.rules` and Firebase Authentication.
   NEVER paste service-account / admin private keys here.

   HOW TO CONNECT A REAL PROJECT
   1. Create a Firebase project and register a web app in the
      Firebase console (Project settings -> Your apps -> Web app).
   2. Copy the `firebaseConfig` values from the console and replace
      every `YOUR_*` value below.
   3. Enable the sign-in methods you want (Authentication -> Sign-in
      method): Google and/or Email/Password.
   4. Deploy `firestore.rules` and `firestore.indexes.json`
      (`firebase deploy --only firestore`).
   ========================================================= */

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD8IOVbktIMNhuziVf40WqhRMpp3pNu04w",
  authDomain: "trustxplpy.firebaseapp.com",
  projectId: "trustxplpy",
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

/* Local emulator support is intentionally disabled in production.
   To run against emulators during development, set to true and run
   the Firebase emulator suite, then define connectFirestoreEmulator /
   connectAuthEmulator calls here. Do not ship this enabled. */
export const EMULATORS = { enabled: false };

let firebridgePromise = null;

/**
 * Initialize (idempotent) Firebase App + Auth + Firestore.
 * The SDK is loaded lazily from the pinned CDN (`import map` in the
 * HTML pages) so the app shell never depends on the network to boot.
 *
 * Offline-first: Firestore is configured with IndexedDB persistence
 * (multi-tab), so data keeps working during temporary internet loss
 * and writes sync automatically when connectivity returns.
 *
 * @returns {Promise<{app, auth, db, googleProvider, authMod, firestore} | null>}
 */
export function initFirebase() {
  if (!isConfigured()) return Promise.resolve(null);
  if (firebridgePromise) return firebridgePromise;

  firebridgePromise = (async () => {
    const [{ initializeApp }, authMod, firestoreMod] = await Promise.all([
      import("firebase/app"),
      import("firebase/auth"),
      import("firebase/firestore"),
    ]);

    const app = initializeApp(FIREBASE_CONFIG);

    const auth = authMod.getAuth(app);
    try {
      await authMod.setPersistence(auth, authMod.browserLocalPersistence);
    } catch (err) {
      /* Local persistence is a convenience; failure is not fatal. */
      console.warn("[seva-ledger] Auth persistence unavailable:", err);
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
      console.warn("[seva-ledger] Firestore IndexedDB persistence unavailable, using in-memory cache:", err);
      db = firestoreMod.getFirestore(app);
    }

    return {
      app,
      auth,
      db,
      googleProvider: new authMod.GoogleAuthProvider(),
      authMod,
      firestore: firestoreMod,
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
  console.warn("[seva-ledger] Firebase init deferred:", err);
});