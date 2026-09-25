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
  "code-invalid": "That code is not recognised. Check with the shop administrator.",
  "enrollment-failed": "Could not register this device. Please try again.",
  "device-store-unavailable":
    "This browser cannot store a trusted-device credential, so every sign-in will require the code.",
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
 * default identity, and the access code setting is seeded with the
 * default SHOP_CODE so device enrollment is server-verified right away.
 * Rules allow each create only while the doc is absent, so concurrent
 * first-runs cannot double-create.
 */
export async function ensureShopRecord() {
  const b = await bridge();
  const fs = b.firestore;
  const user = getCurrentUser();
  if (!user) throw new AuthError("not-signed-in", friendly("not-signed-in"));

  const generalRef = fs.doc(b.db, "settings", "general");
  const generalSnap = await fs.getDoc(generalRef);
  let general = generalSnap.exists() ? generalSnap.data() : null;
  if (!general) {
    try {
      await fs.setDoc(generalRef, {
        ...DEFAULT_SHOP,
        createdAt: fs.serverTimestamp(),
        createdBy: user.uid,
      });
    } catch (err) {
      if (err && err.code === "permission-denied") {
        // Lost the race — another device created it first.
      } else {
        throw err;
      }
    }
    const again = await fs.getDoc(generalRef);
    general = again.exists() ? again.data() : general;
  }

  /* Seed the access code once (server verifies enrollment against it). */
  const securityRef = fs.doc(b.db, "settings", "security");
  const securitySnap = await fs.getDoc(securityRef);
  if (!securitySnap.exists()) {
    try {
      await fs.setDoc(securityRef, {
        accessCode: SHOP_CODE,
        createdAt: fs.serverTimestamp(),
        createdBy: user.uid,
      });
    } catch (err) {
      if (err && err.code === "permission-denied") {
        // Already seeded by another device.
      } else {
        throw err;
      }
    }
  }

  return general;
}

/* =========================================================
   Trusted devices (auto-login)
   -----------------------------------------------------------------
   A recognized browser holds a cryptographically secure 256-bit token
   stored ONLY in IndexedDB (firebase-managed sessions already use it;
   localStorage is avoided for long-lived credentials). Its SHA-256 is
   the Firestore document id under devices/<tokenHash>, so the token is
   never transmitted or stored server-side — a revoked or absent active
   doc simply stops auto-login. Enrollment is server-verified against
   settings/security via a single-use enrollments/<nonce> doc.
   ========================================================= */

const TOKEN_BYTES = 32; // 256 bits

function nonceHex() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when the browser can keep the credential + hash tokens (HTTPS/localhost). */
export function canStoreDeviceCredential() {
  return typeof window !== "undefined"
    && typeof indexedDB !== "undefined"
    && (window.isSecureContext === undefined || window.isSecureContext === true)
    && typeof crypto !== "undefined"
    && typeof crypto.subtle !== "undefined";
}

/* ---------- IndexedDB credential store ---------- */

const DEVICE_DB = "seva-ledger";
const DEVICE_STORE = "kv";
const DEVICE_KEY = "seva.device";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DEVICE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DEVICE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEVICE_STORE, "readonly");
    const req = tx.objectStore(DEVICE_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEVICE_STORE, "readwrite");
    tx.objectStore(DEVICE_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEVICE_STORE, "readwrite");
    tx.objectStore(DEVICE_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadDeviceCredential() {
  if (!canStoreDeviceCredential()) return null;
  try {
    return (await idbGet(DEVICE_KEY)) || null;
  } catch (err) {
    console.warn("[seva-ledger] device credential read failed:", err);
    return null;
  }
}

export async function saveDeviceCredential(token) {
  if (!canStoreDeviceCredential()) return false;
  try {
    await idbSet(DEVICE_KEY, token);
    return true;
  } catch (err) {
    console.warn("[seva-ledger] device credential save failed:", err);
    return false;
  }
}

export async function clearDeviceCredential() {
  if (!canStoreDeviceCredential()) return;
  try {
    await idbDelete(DEVICE_KEY);
  } catch (err) {
    console.warn("[seva-ledger] device credential clear failed:", err);
  }
}

/* ---------- Token + hashing ---------- */

/** A 256-bit random token, hex-encoded (64 chars). */
export function generateDeviceToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the token — the Firestore doc id. Never reversed server-side. */
export async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- Device metadata (privacy: no IP, no fingerprinting) ---------- */

function shortUA(userAgent) {
  const ua = typeof userAgent === "string" ? userAgent : "";
  const pick = (browser, version) => {
    const m = ua.match(browser);
    return m
      ? (browser[0].toUpperCase() + browser.slice(1)).replace("/", " ") + (m[1] ? " " + m[1] : "")
      : null;
  };
  const os =
    /Windows NT 10/.test(ua) ? "Windows"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS"
    : /iPhone/.test(ua) || /iPad/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux"
    : "Unknown OS";
  const browser =
    pick(/Edg\/([\d]+)/, 1) || pick(/Chrome\/([\d]+)/, 1) ||
    pick(/Firefox\/([\d]+)/, 1) || pick(/Safari\/([\d]+)/, 1) || "Browser";
  return (os + " · " + browser).slice(0, 100);
}

function collectNetwork() {
  const conn = typeof navigator !== "undefined" ? navigator.connection : null;
  return {
    type: conn && typeof conn.type === "string" ? conn.type : "",
    saveData: Boolean(conn && conn.saveData),
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
  };
}

function defaultDeviceLabel() {
  return shortUA(typeof navigator !== "undefined" ? navigator.userAgent : "");
}

/* ---------- Enrollment + management ---------- */

/**
 * Register THIS browser as a trusted device and store its credential.
 * Requires a signed-in anonymous session (rule ensures enrollment only
 * after this device proved the code). Generates a fresh token each run,
 * so re-verifying after a revocation creates a brand-new credential.
 */
export async function enrollDevice({ label } = {}) {
  if (!canStoreDeviceCredential()) {
    throw new AuthError("device-store-unavailable", friendly("device-store-unavailable"));
  }
  const user = await signInAnonymous();
  const b = await bridge();
  const fs = b.firestore;

  await ensureShopRecord();

  const token = generateDeviceToken();
  const tokenHash = await hashToken(token);
  const nonce = nonceHex();

  /* One-time proof-of-code; the rules compare against settings/security. */
  try {
    await fs.setDoc(fs.doc(b.db, "enrollments", nonce), {
      verifiedCode: SHOP_CODE,
      createdAt: fs.serverTimestamp(),
      createdBy: user.uid,
      used: false,
    });
  } catch (err) {
    if (err && err.code === "permission-denied") {
      throw new AuthError("code-invalid", friendly("code-invalid"));
    }
    throw new AuthError("enrollment-failed", friendly("enrollment-failed"));
  }

  const deviceRef = fs.doc(b.db, "devices", tokenHash);
  const client = {
    ua: shortUA(navigator.userAgent),
    lang: (typeof navigator !== "undefined" && navigator.language) || "",
  };
  const network = collectNetwork();
  const now = fs.serverTimestamp();

  await fs.setDoc(deviceRef, {
    tokenHash,
    uid: user.uid,
    label: String(label || defaultDeviceLabel()).trim().slice(0, 80) || defaultDeviceLabel(),
    client,
    network,
    createdAt: now,
    createdBy: user.uid,
    lastUsedAt: now,
    lastUsedNetwork: network,
    active: true,
    enrollmentId: nonce,
  });

  /* Burn the one-time enrollment. */
  try {
    await fs.updateDoc(fs.doc(b.db, "enrollments", nonce), {
      used: true,
      deviceHash: tokenHash,
    });
  } catch (err) {
    console.warn("[seva-ledger] enrollment mark-used failed:", err);
  }

  const saved = await saveDeviceCredential(token);

  return { tokenHash, token, device: (await fs.getDoc(deviceRef)).data() || {} };
}

/**
 * Check whether THIS browser is a trusted device. Runs on every load —
 * even when an anonymous session already exists — so revocation takes
 * effect immediately.
 * @returns {Promise<{trusted: boolean, reason: string, device?: object, tokenHash?: string}>}
 */
export async function checkTrustedDevice() {
  if (!canStoreDeviceCredential()) return { trusted: false, reason: "store-unavailable" };
  const token = await loadDeviceCredential();
  if (!token) return { trusted: false, reason: "no-credential" };

  let tokenHash;
  try {
    tokenHash = await hashToken(token);
  } catch (err) {
    return { trusted: false, reason: "hash-failed", error: err };
  }

  try {
    const b = await bridge();
    const fs = b.firestore;
    const snap = await fs.getDoc(fs.doc(b.db, "devices", tokenHash));
    if (!snap.exists()) return { trusted: false, reason: "not-found", tokenHash };
    const d = snap.data();
    if (d.active !== true) return { trusted: false, reason: "revoked", tokenHash, device: d };
    return { trusted: true, reason: "ok", tokenHash, device: d };
  } catch (err) {
    /* Transient failure / rules deny: fall back to verification, never
       leave the user stuck (the login page handles it gracefully). */
    return { trusted: false, reason: "error", error: err, tokenHash };
  }
}

/** Fire-and-forget heartbeat so the admin list shows last-used times. */
export async function updateDeviceLastUsed(tokenHash) {
  if (!tokenHash) return;
  try {
    const b = await bridge();
    const fs = b.firestore;
    const network = collectNetwork();
    await fs.updateDoc(fs.doc(b.db, "devices", tokenHash), {
      lastUsedAt: fs.serverTimestamp(),
      lastUsedNetwork: network,
    });
  } catch (err) {
    /* Non-fatal: a revoked/removed device just stops heartbeating. */
    console.warn("[seva-ledger] device heartbeat failed:", err);
  }
}

/* ---------- Device management (Developer console) ---------- */

/** All trusted devices, newest first. */
export async function listTrustedDevices() {
  const b = await bridge();
  const fs = b.firestore;
  const snap = await fs.getDocs(fs.collection(b.db, "devices"));
  return snap.docs
    .map((d) => ({ tokenHash: d.id, ...d.data() }))
    .sort((a, x) => {
      const at = a.createdAt ? Number(a.createdAt.toMillis?.() || 0) : 0;
      const xt = x.createdAt ? Number(x.createdAt.toMillis?.() || 0) : 0;
      return xt - at;
    });
}

/** Revoke a device's trust (any signed-in device may). */
export async function revokeDevice(tokenHash) {
  const b = await bridge();
  const fs = b.firestore;
  await fs.updateDoc(fs.doc(b.db, "devices", tokenHash), { active: false });
}

/** Reactivate a device (owner only; rules enforce). */
export async function restoreDevice(tokenHash) {
  const b = await bridge();
  const fs = b.firestore;
  const network = collectNetwork();
  await fs.updateDoc(fs.doc(b.db, "devices", tokenHash), {
    active: true,
    lastUsedAt: fs.serverTimestamp(),
    lastUsedNetwork: network,
  });
}

/** Permanently remove a device record. */
export async function removeDevice(tokenHash) {
  const b = await bridge();
  const fs = b.firestore;
  await fs.deleteDoc(fs.doc(b.db, "devices", tokenHash));
}