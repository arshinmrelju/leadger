/* =========================================================
   TrustX Ledger — Single-code sign-in
   -----------------------------------------------------------------
   The whole app opens with one shared code (SHOP_CODE, "TRUSTX").
   Entering it signs the browser in anonymously and grants full access
   to the ledger itself — there are no accounts, roles or memberships.

   The Developer console (admin.html) sits behind a SECOND code
   (ADMIN_CODE). It is not linked from the public navigation and the
   shop code alone cannot open it: a browser must additionally present
   the admin code, which the rules exchange for an `admins/{uid}`
   grant. That grant is what the rules check before allowing device
   management.

   WHAT LIVES WHERE
   The identity and trust registry are REALTIME DATABASE paths now
   (settings/*, enrollments, devices, admins) — see database.rules.json.
   The money is in Firestore, partitioned by day. This module never
   touches Firestore: it only decides who is allowed in, and the two
   rule sets agree on `request.auth != null` plus the device grant.

   Both code checks are CONVENIENCE gates for the UI. Real record
   integrity is enforced by the rule files (signed-in user, every
   document typed and non-forgeable: createdBy == uid, createdAt ==
   the server clock, admin grants require an unused admin-scope
   enrollment, and in Firestore total == quantity * rate with the day's
   counters moving by exactly the sale that moved them).
   ========================================================= */

import { getFirebridge } from "./firebase.js";

export const SHOP_CODE = "TRUSTX";
export const ADMIN_CODE = "TRUSTXADMIN";

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
  "admin-code-invalid": "That admin code is not recognised.",
  "admin-grant-failed": "Could not unlock the developer console. Please try again.",
  "admin-not-trusted":
    "This browser is not a trusted device yet. Sign in with the shop code first, then unlock the console.",
  "enrollment-failed": "Could not register this device. Please try again.",
  "device-store-unavailable":
    "This browser cannot store a trusted-device credential, so every sign-in will require the code.",
  "database-unavailable":
    "Realtime Database is not reachable. Check databaseURL in js/firebase.js and that database.rules.json is deployed.",
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
    /* Neither database's raw "Missing or insufficient permissions." is
       ever actionable for the shop user — the rules are the shop's own.
       Firestore says permission-denied, Realtime Database says
       PERMISSION_DENIED, and both mean the same thing here. */
    if (isPermissionDenied(err)) {
      return "The ledger rejected that request. Make sure the latest rules are deployed, then try again.";
    }
    return err.message;
  }
  return "Something went wrong. Please try again.";
}

/** Permission denial from either database, normalized to one check. */
function isPermissionDenied(err) {
  if (!err) return false;
  const code = err.code ? String(err.code) : "";
  return code === "permission-denied" || code === "PERMISSION_DENIED" ||
    /insufficient permissions|permission denied/i.test(err.message || "");
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

/**
 * The Firebase bridge with Realtime Database resolved. Everything in
 * this module is an identity/trust path, so unlike the ledger there is
 * nothing here worth degrading to a half-working state: if the database
 * is unreachable the shop cannot be verified at all, and a clear error
 * beats a silent one.
 */
async function rtdbBridge() {
  const b = await bridge();
  if (!b.rtdb) {
    throw new AuthError(
      "database-unavailable",
      "Realtime Database is not reachable. Check databaseURL in js/firebase.js and that database.rules.json is deployed."
    );
  }
  return b;
}

export function getCurrentUser() {
  return currentUser;
}

function notify(user) {
  currentUser = user;
  ready = true;
  subscribers.forEach((cb) => {
    try { cb(user, ready); } catch (err) { console.error("[trustx-ledger] auth subscriber error:", err); }
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
    console.warn("[trustx-ledger] signOut:", err);
  } finally {
    notify(null);
    redirecting = false;
  }
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
  name: "TrustX Ledger",
  phone: "",
  address: "",
  currency: "INR",
  active: true,
};

/** The single shop's settings/general record, or null if not created. */
export async function getGeneral() {
  const b = await rtdbBridge();
  const rt = b.rtdbMod;
  const snap = await rt.get(rt.ref(b.rtdb, "settings", "general"));
  return snap.exists() ? snap.val() : null;
}

/**
 * Silently ensure the shop record exists (first code login on a fresh
 * project). There is no setup screen: the shop is created with the
 * default identity, and the access code setting is seeded with the
 * default SHOP_CODE so device enrollment is server-verified right away.
 * Rules allow each create only while the record is absent, so concurrent
 * first-runs cannot double-create.
 */
export async function ensureShopRecord() {
  const b = await rtdbBridge();
  const rt = b.rtdbMod;
  const user = getCurrentUser();
  if (!user) throw new AuthError("not-signed-in", friendly("not-signed-in"));

  const generalSnap = await rt.get(rt.ref(b.rtdb, "settings", "general"));
  let general = generalSnap.exists() ? generalSnap.val() : null;
  if (!general) {
    try {
      await rt.set(rt.ref(b.rtdb, "settings", "general"), {
        ...DEFAULT_SHOP,
        createdAt: rt.serverTimestamp(),
        createdBy: user.uid,
      });
    } catch (err) {
      if (!isPermissionDenied(err)) {
        throw err;
      }
      // Lost the race — another device created it first.
    }
    const again = await rt.get(rt.ref(b.rtdb, "settings", "general"));
    general = again.exists() ? again.val() : general;
  }

  /* Seed the access code once (the rules verify an enrollment against
     it). settings/security is never client-readable, so we must NOT probe
     it with a get(): the rules deny that read and it would fail on every
     sign-in. The write rule only allows it while the record is absent, so
     "denied" simply means another device already seeded it. Same story
     for the admin code. */
  try {
    await rt.set(rt.ref(b.rtdb, "settings", "security"), {
      accessCode: SHOP_CODE,
      createdAt: rt.serverTimestamp(),
      createdBy: user.uid,
    });
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
  }

  try {
    await rt.set(rt.ref(b.rtdb, "settings", "admin"), {
      adminCode: ADMIN_CODE,
      createdAt: rt.serverTimestamp(),
      createdBy: user.uid,
    });
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
  }

  return general;
}

/* =========================================================
   Trusted devices (auto-login)
   -----------------------------------------------------------------
   A recognized browser holds a cryptographically secure 256-bit token
   stored ONLY in IndexedDB (firebase-managed sessions already use it;
   localStorage is avoided for long-lived credentials). Its SHA-256 is
   the Realtime Database key under devices/<tokenHash>, so the token is
   never transmitted or stored server-side — a revoked or absent active
   record simply stops auto-login. Enrollment is server-verified against
   settings/security via a single-use enrollments/<nonce> record.
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

const DEVICE_DB = "trustx-ledger";
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

export async function loadDeviceCredential() {
  if (!canStoreDeviceCredential()) return null;
  try {
    return (await idbGet(DEVICE_KEY)) || null;
  } catch (err) {
    console.warn("[trustx-ledger] device credential read failed:", err);
    return null;
  }
}

export async function saveDeviceCredential(token) {
  if (!canStoreDeviceCredential()) return false;
  try {
    await idbSet(DEVICE_KEY, token);
    return true;
  } catch (err) {
    console.warn("[trustx-ledger] device credential save failed:", err);
    return false;
  }
}

/* ---------- Token + hashing ---------- */

/** A 256-bit random token, hex-encoded (64 chars). */
export function generateDeviceToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the token — the Realtime Database key. Never reversed server-side. */
export async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- Device metadata (privacy: no IP, no fingerprinting) ---------- */

function shortUA(userAgent) {
  const ua = typeof userAgent === "string" ? userAgent : "";
  /* `pattern` locates the version digits, `name` is the display label.
     Note: a RegExp has no indexed properties, so the label must be a
     real string here — never derive it from `pattern`. */
  const pick = (pattern, name) => {
    const m = ua.match(pattern);
    return m ? name + (m[1] ? " " + m[1] : "") : null;
  };
  /* iOS also contains "Mac OS X", so the phone tokens must be tested
     before the desktop one. */
  const os =
    /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Windows NT 10/.test(ua) ? "Windows"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux"
    : "Unknown OS";
  /* Chromium-based browsers all carry "Chrome/", so the more specific
     tokens must be tested first or everything reads as Chrome. */
  const browser =
    pick(/Edg(?:A|iOS)?\/([\d]+)/, "Edge") ||
    pick(/OPR\/([\d]+)/, "Opera") ||
    pick(/Firefox\/([\d]+)/, "Firefox") ||
    pick(/Chrome\/([\d]+)/, "Chrome") ||
    pick(/Version\/([\d.]+).*Safari/, "Safari") ||
    (/Safari/.test(ua) ? "Safari" : null) ||
    "Browser";
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
 * Requires a signed-in anonymous session (the rules ensure an enrollment
 * only exists after this device proved the code). Generates a fresh token
 * each run, so re-verifying after a revocation creates a brand-new
 * credential.
 */
export async function enrollDevice({ label } = {}) {
  if (!canStoreDeviceCredential()) {
    throw new AuthError("device-store-unavailable", friendly("device-store-unavailable"));
  }
  const user = await signInAnonymous();
  const b = await rtdbBridge();
  const rt = b.rtdbMod;

  await ensureShopRecord();

  const token = generateDeviceToken();
  const tokenHash = await hashToken(token);
  const nonce = nonceHex();

  /* One-time proof-of-code; the rules compare against settings/security. */
  try {
    await rt.set(rt.ref(b.rtdb, "enrollments", nonce), {
      scope: "shop",
      verifiedCode: SHOP_CODE,
      createdAt: rt.serverTimestamp(),
      createdBy: user.uid,
      used: false,
    });
  } catch (err) {
    if (isPermissionDenied(err)) {
      throw new AuthError("code-invalid", friendly("code-invalid"));
    }
    throw new AuthError("enrollment-failed", friendly("enrollment-failed"));
  }

  const deviceRef = rt.ref(b.rtdb, "devices", tokenHash);
  const client = {
    ua: shortUA(navigator.userAgent),
    lang: (typeof navigator !== "undefined" && navigator.language) || "",
  };
  const network = collectNetwork();

  try {
    await rt.set(deviceRef, {
      tokenHash,
      uid: user.uid,
      label: String(label || defaultDeviceLabel()).trim().slice(0, 80) || defaultDeviceLabel(),
      client,
      network,
      createdAt: rt.serverTimestamp(),
      createdBy: user.uid,
      lastUsedAt: rt.serverTimestamp(),
      lastUsedNetwork: network,
      active: true,
      enrollmentId: nonce,
    });
  } catch (err) {
    /* Never let a raw "permission denied" reach the login screen — the
       rules rejected the registry write for one of our own reasons. */
    console.error("[trustx-ledger] device registration rejected:", err);
    throw new AuthError("enrollment-failed", friendly("enrollment-failed"));
  }

  /* Burn the one-time enrollment. */
  try {
    await rt.update(rt.ref(b.rtdb, "enrollments", nonce), {
      used: true,
      deviceHash: tokenHash,
    });
  } catch (err) {
    console.warn("[trustx-ledger] enrollment mark-used failed:", err);
  }

  await saveDeviceCredential(token);

  const deviceSnap = await rt.get(deviceRef);
  return { tokenHash, token, device: deviceSnap.val() || {} };
}

/**
 * Check whether THIS browser is a trusted device. Runs on every load —
 * even when an anonymous session already exists — so revocation takes
 * effect immediately.
 *
 * The read of a single device is a CAPABILITY read: the key is the
 * sha256 of a 256-bit token only this browser holds, so the rules let an
 * unauthenticated visitor read exactly that one record to run the gate
 * BEFORE any session exists.
 *
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
    const b = await rtdbBridge();
    const rt = b.rtdbMod;
    const snap = await rt.get(rt.ref(b.rtdb, "devices", tokenHash));
    if (!snap.exists()) return { trusted: false, reason: "not-found", tokenHash };
    const d = snap.val();
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
    const b = await rtdbBridge();
    const rt = b.rtdbMod;
    await rt.update(rt.ref(b.rtdb, "devices", tokenHash), {
      lastUsedAt: rt.serverTimestamp(),
      lastUsedNetwork: collectNetwork(),
    });
  } catch (err) {
    /* Non-fatal: a revoked/removed device just stops heartbeating. */
    console.warn("[trustx-ledger] device heartbeat failed:", err);
  }
}

/* ---------- Device management (Developer console) ---------- */

/** All trusted devices, newest first. */
export async function listTrustedDevices() {
  const b = await rtdbBridge();
  const rt = b.rtdbMod;
  const snap = await rt.get(rt.ref(b.rtdb, "devices"));
  const raw = snap.val() || {};
  return Object.keys(raw)
    .map((key) => ({ tokenHash: key, ...raw[key] }))
    .sort((a, x) => Number(x.createdAt || 0) - Number(a.createdAt || 0));
}

/** Revoke a device's trust (admin grant required; rules enforce). */
export async function revokeDevice(tokenHash) {
  const b = await rtdbBridge();
  const rt = b.rtdbMod;
  await rt.update(rt.ref(b.rtdb, "devices", tokenHash), { active: false });
}

/** Reactivate a device (admin grant required; rules enforce). */
export async function restoreDevice(tokenHash) {
  const b = await rtdbBridge();
  const rt = b.rtdbMod;
  await rt.update(rt.ref(b.rtdb, "devices", tokenHash), {
    active: true,
    lastUsedAt: rt.serverTimestamp(),
    lastUsedNetwork: collectNetwork(),
  });
}

/** Permanently remove a device record (admin grant required). */
export async function removeDevice(tokenHash) {
  const b = await rtdbBridge();
  const rt = b.rtdbMod;
  await rt.remove(rt.ref(b.rtdb, "devices", tokenHash));
}

/* =========================================================
   Admin access (the Developer console gate)
   -----------------------------------------------------------------
   The console is not reachable from the public navigation and needs a
   second code. Presenting it writes an admin-scope enrollment proof,
   which the rules verify against settings/admin, and only then mints
   `admins/{uid}` — the record the rules check before allowing any
   device management. The grant lives server-side, so it survives cache
   clears and applies to this browser (uid), not just this page.
   ========================================================= */

/** Does THIS browser hold an admin grant? */
export async function checkAdminAccess() {
  try {
    const b = await rtdbBridge();
    const rt = b.rtdbMod;
    const user = getCurrentUser();
    if (!user) return false;
    const snap = await rt.get(rt.ref(b.rtdb, "admins", user.uid));
    return snap.exists() === true;
  } catch (err) {
    /* Offline or rules denied: fail closed — the console stays shut. */
    console.warn("[trustx-ledger] admin grant check failed:", err);
    return false;
  }
}

/** uids that hold an admin grant (rules allow this list to admins only). */
export async function listAdminGrants() {
  const b = await rtdbBridge();
  const rt = b.rtdbMod;
  const snap = await rt.get(rt.ref(b.rtdb, "admins"));
  return Object.keys(snap.val() || {});
}

/**
 * Exchange the admin code for a grant on this browser.
 * Throws AuthError("admin-code-invalid") when the rules reject the proof.
 */
export async function grantAdminAccess(code) {
  const typed = normalizeCode(code);
  if (!typed) {
    throw new AuthError("admin-code-invalid", friendly("admin-code-invalid"));
  }

  const user = await signInAnonymous();
  const b = await rtdbBridge();
  const rt = b.rtdbMod;

  await ensureShopRecord();

  /* The grant is bound to this browser's device token, so the console is
     opened by a device the owner can see and revoke. */
  const token = await loadDeviceCredential();
  if (!token) {
    throw new AuthError("admin-not-trusted", friendly("admin-not-trusted"));
  }
  const tokenHash = await hashToken(token);
  const nonce = nonceHex();

  /* One-time proof of the ADMIN code; the rules compare it to
     settings/admin.adminCode, so a wrong code is refused server-side. */
  try {
    await rt.set(rt.ref(b.rtdb, "enrollments", nonce), {
      scope: "admin",
      verifiedCode: typed,
      createdAt: rt.serverTimestamp(),
      createdBy: user.uid,
      used: false,
    });
  } catch (err) {
    if (isPermissionDenied(err)) {
      throw new AuthError("admin-code-invalid", friendly("admin-code-invalid"));
    }
    throw new AuthError("admin-grant-failed", friendly("admin-grant-failed"));
  }

  try {
    await rt.set(rt.ref(b.rtdb, "admins", user.uid), {
      uid: user.uid,
      deviceHash: tokenHash,
      enrollmentId: nonce,
      createdAt: rt.serverTimestamp(),
      createdBy: user.uid,
    });
  } catch (err) {
    console.error("[trustx-ledger] admin grant rejected:", err);
    throw new AuthError("admin-grant-failed", friendly("admin-grant-failed"));
  }

  /* Burn the one-time proof. */
  try {
    await rt.update(rt.ref(b.rtdb, "enrollments", nonce), {
      used: true,
      deviceHash: tokenHash,
    });
  } catch (err) {
    console.warn("[trustx-ledger] admin enrollment mark-used failed:", err);
  }

  return true;
}