/* =========================================================
   SEVA LEDGER — Single-code sign-in
   -----------------------------------------------------------------
   The whole app opens with one shared code (SHOP_CODE, "TRUSTX").
   Entering it signs the browser in anonymously and grants full access
   to everything, including the Developer console — there are no
   accounts, roles or memberships.

   The code check is a CONVENIENCE gate: it happens in the browser.
   Real record integrity is enforced by firestore.rules (signed-in
   user, every document typed and non-forgeable: createdBy == uid,
   total == quantity * rate, service must exist and be active, ...).
   ========================================================= */

import { getFirebridge } from "./firebase.js";

export const SHOP_CODE = "TRUSTX";

/* ---------------- Errors ---------------- */

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

const AUTH_MESSAGES = {
  "not-configured":
    "Firebase is not configured yet. Add your web app config in js/firebase.js.",
  "not-signed-in": "You are not signed in.",
  "network-request-failed": "Network problem. Check your connection and try again.",
  "operation-not-allowed":
    "Anonymous sign-in is not enabled for this Firebase project. Enable it under Authentication → Sign-in method.",
  "too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
  "code-invalid": "That code is not recognised. Try TRUSTX.",
};

function friendly(code, fallback) {
  const msg = AUTH_MESSAGES[code];
  if (msg) return msg;
  if (/^auth\//.test(code || "")) return "Sign-in failed. Please try again.";
  return fallback || "Something went wrong. Please try again.";
}

function toAuthError(fbErr) {
  const code = fbErr && fbErr.code ? fbErr.code : "";
  if (code === "CONFIG_REQUIRED" || code === "not-configured") return new AuthError("not-configured", friendly("not-configured"));
  if (code === "not-signed-in") return new AuthError(code, friendly(code));

  switch (code) {
    case "auth/network-request-failed": return new AuthError("network-request-failed", friendly("network-request-failed"));
    case "auth/operation-not-allowed": return new AuthError("operation-not-allowed", friendly("operation-not-allowed"));
    case "auth/too-many-requests": return new AuthError("too-many-requests", friendly("too-many-requests"));
    default: return new AuthError("unknown", friendly("", code));
  }
}

/** Convert any thrown error into a safe, human-readable message string. */
export function reportError(err) {
  if (err instanceof AuthError) return err.message;
  if (err && typeof err.message === "string") {
    if (/^auth\//.test(err.message)) return toAuthError(err).message;
    return err.message;
  }
  return "Something went wrong. Please try again.";
}

/* ---------------- Internal state ---------------- */

let bridgeCache = null;
let currentUser = null;
let ready = false;
let redirecting = false;
const subscribers = new Set();

async function bridge() {
  if (bridgeCache) return bridgeCache;
  const b = await getFirebridge();
  if (!b) throw new AuthError("not-configured", friendly("not-configured"));
  bridgeCache = b;
  return b;
}

export function isAuthReady() {
  return ready;
}

export function getCurrentUser() {
  return currentUser;
}

function notify(user) {
  currentUser = user;
  ready = true;
  subscribers.forEach((cb) => {
    try { cb(user, ready); } catch (err) { console.error("[seva-ledger] auth subscriber error:", err); }
  });
}

/**
 * Start the auth state listener (idempotent). Wait for this before
 * reading `getCurrentUser()` — it resolves once the persisted session
 * has been restored (refresh-safe) or confirmed absent.
 * Does NOT create an anonymous account on its own; that only happens
 * after the access code is accepted (signInAnonymous).
 */
export async function initAuth() {
  const b = await bridge();
  if (b._sevaAuthInited) return;
  b._sevaAuthInited = true;
  b.authMod.onAuthStateChanged(b.auth, (user) => notify(user));
  await new Promise((resolve) => {
    const check = () => (ready ? resolve() : setTimeout(check, 25));
    check();
  });
}

/** Subscribe to auth changes. Returns an unsubscribe function. */
export function onAuthStateChange(cb) {
  subscribers.add(cb);
  if (ready) cb(currentUser, ready);
  return () => subscribers.delete(cb);
}

/* ---------------- The code ---------------- */

/** Normalize a user-typed code: uppercase, no spaces. */
export function normalizeCode(input) {
  return String(input || "").toUpperCase().replace(/\s+/g, "").trim();
}

/** True if the typed code matches the shop code (case/space tolerant). */
export function isCorrectCode(input) {
  return normalizeCode(input) === SHOP_CODE;
}

/* ---------------- Sign-in / sign-out ---------------- */

/**
 * Create the persistent anonymous session for this browser. This is the
 * ONLY sign-in path now. Firestore identities the device by uid; the
 * anonymous credential is kept so the shop computer stays signed in.
 */
export async function signInAnonymous() {
  const b = await bridge();
  if (currentUser) return currentUser;
  try {
    const cred = await b.authMod.signInAnonymously(b.auth);
    return cred.user;
  } catch (err) {
    throw toAuthError(err);
  }
}

export async function signOut() {
  redirecting = true;
  try {
    const b = await bridge();
    if (b.auth.currentUser) await b.authMod.signOut(b.auth);
  } catch (err) {
    console.warn("[seva-ledger] signOut:", err);
  } finally {
    notify(null);
    redirecting = false;
  }
}

export function clearSession() {
  /* Session is fully auth-owned in the single-code model. */
}

/* ---------------- Protected-page handling ---------------- */

/**
 * For protected pages: resolves once auth is restored. Returns the user,
 * or null (page decides: normally location.replace(login.html)).
 */
export async function requireAuth(redirectTo = "login.html") {
  try {
    await initAuth();
  } catch (err) {
    if (err instanceof AuthError && err.code === "not-configured") return null;
    throw err;
  }
  if (!getCurrentUser()) {
    if (!redirecting) window.location.replace(redirectTo);
    return null;
  }
  return getCurrentUser();
}

/**
 * Auto-redirect a protected page to the login screen if the session
 * disappears (logout here or in another tab, expired session, etc.).
 * Call once per page after requireAuth() succeeded.
 */
export function guardPage(redirectTo = "login.html") {
  window.addEventListener("beforeunload", () => {
    redirecting = false;
  });
  onAuthStateChange((user) => {
    if (!user && !redirecting && !window.location.pathname.endsWith(redirectTo)) {
      window.location.replace(redirectTo);
    }
  });
}

/* ---------------- Shop record ---------------- */

const DEFAULT_SHOP = {
  name: "SEVA LEDGER",
  phone: "",
  address: "",
  currency: "INR",
  active: true,
};

/** The single shop's settings/general record, or null if not created. */
export async function getGeneral() {
  const b = await bridge();
  const fs = b.firestore;
  const snap = await fs.getDoc(fs.doc(b.db, "settings", "general"));
  return snap.exists() ? snap.data() : null;
}

/**
 * Silently ensure the shop record exists (first code login on a fresh
 * project). There is no setup screen: the shop is created with the
 * default identity. Rules allow this only while settings/general is
 * absent, so a concurrent first-run cannot double-create it.
 */
export async function ensureShopRecord() {
  const b = await bridge();
  const fs = b.firestore;
  const user = getCurrentUser();
  if (!user) throw new AuthError("not-signed-in", friendly("not-signed-in"));
  const ref = fs.doc(b.db, "settings", "general");
  const snap = await fs.getDoc(ref);
  if (snap.exists()) return snap.data();
  try {
    await fs.setDoc(ref, {
      ...DEFAULT_SHOP,
      createdAt: fs.serverTimestamp(),
      createdBy: user.uid,
    });
  } catch (err) {
    if (err && err.code === "permission-denied") {
      // Lost the race — another device created it first. Re-read.
      const again = await fs.getDoc(ref);
      if (again.exists()) return again.data();
    }
    throw err;
  }
  return (await fs.getDoc(ref)).data();
}