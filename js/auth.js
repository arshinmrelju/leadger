/* =========================================================
   TrustX Ledger — Sign-in and trusted-browser access
   -----------------------------------------------------------------
   The app opens with a shared SHOP CODE, and the Developer console
   (admin.html) with a separate ADMIN CODE. Neither code is in this
   file, in any other file in the repository, or in the deployed
   bundle — a code that ships to the browser is a code that is
   published.

   HOW A CODE BECOMES ACCESS (all of it server-side, in firestore.rules)
     1. The browser hashes what was typed: sha256(code) via Web Crypto.
        Only that 64-char hash is sent.
     2. firestore.rules accepts enrollments/{uid} only when the hash
        equals the stored securitySecrets/{shop|admin}.codeHash, which
        only the Admin SDK (tools/bootstrap-access.mjs) can write. A
        wrong code simply does not match, so nothing is created.
     3. The matching proof buys accessGrants/{uid} — a server-side
        record that every money rule re-reads on every request. An
        anonymous Firebase session on its own grants nothing, because
        signing in anonymously is free and open to anybody.
     4. Revoking a grant in the Developer console locks that browser
        out on its very next request.

   The codes are therefore only ever *proven*, never *compared*, on the
   client. The remaining weakness is stated plainly in the README: a
   code can still be guessed online, so Firebase App Check (or moving
   the check into a callable function) is the production control for
   that. What the rules buy is that the ledger is no longer open to
   every anonymous Firebase user in existence.
   ========================================================= */

import { getFirebridge } from "./firebase.js";

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
  "network-request-failed":
    "Network problem. Check your connection and try again.",
  "operation-not-allowed":
    "Anonymous sign-in is not enabled for this Firebase project. Enable it under Authentication → Sign-in method.",
  "too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
  "code-invalid":
    "That code is not recognised. Check with the shop administrator — and if this shop has never been set up, the access codes still have to be created once (see the README).",
  "admin-code-invalid": "That admin code is not recognised.",
  "admin-grant-failed": "Could not unlock the developer console. Please try again.",
  "admin-not-trusted":
    "Sign in with the shop code on this browser first, then unlock the console.",
  "enrollment-failed": "Could not complete sign-in. Please try again.",
  "access-not-ready":
    "This browser is not enrolled yet. Sign in with the shop code.",
  "access-revoked":
    "This browser's access was revoked. Sign in with the shop code again.",
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

/** Firestore Timestamps, and the odd plain number, as epoch millis. */
function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value === "number") return value;
  return 0;
}

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
 * The Firestore handle. Trust and the shop record live in the same
 * database as the money precisely so the rules can gate them on the same
 * grant, so this is the bridge every access function below uses. A broken
 * `databaseURL` must not be able to block sign-in: only expenses, which
 * are still on the Realtime Database, degrade without it.
 */
async function storeBridge() {
  return bridge();
}

function grantRef(fs, db, uid) {
  return fs.doc(db, "accessGrants", uid);
}

function enrollRef(fs, db, uid) {
  return fs.doc(db, "enrollments", uid);
}

function shopRef(fs, db) {
  return fs.doc(db, "shop", "general");
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
 * THE gate every protected page goes through.
 *
 * A session is not access: it only proves the browser is signed in, and
 * signing in anonymously is something anyone can do. This reads the
 * browser's own `accessGrants/{uid}` record — the same record
 * firestore.rules consults before it will serve a single rupee — and
 * sends anything without an active grant back to the login screen. So a
 * revoked browser is out on its very next page load, and a browser that
 * somehow holds a session it was never granted cannot read the ledger
 * even if it skips this function.
 *
 * @param {string} [redirectTo]
 * @param {object}  [opts]
 * @param {boolean} [opts.touch] refresh the grant's last-seen stamp
 * @returns {Promise<object|null>} the grant, or null once redirected
 */
export async function requireAccess(redirectTo = "login.html", { touch = true } = {}) {
  const user = await requireAuth(redirectTo);
  if (!user) return null;

  const grant = await getAccessGrant();
  if (!grant) {
    if (!redirecting) window.location.replace(redirectTo + "?reason=not-enrolled");
    return null;
  }
  if (grant.active !== true) {
    if (!redirecting) window.location.replace(redirectTo + "?reason=revoked");
    return null;
  }

  if (touch) touchAccessGrant();
  return grant;
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

/** The single shop's record, or null if it has not been created yet. */
export async function getGeneral() {
  try {
    const b = await storeBridge();
    const fs = b.firestore;
    const snap = await fs.getDoc(shopRef(fs, b.db));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn("[trustx-ledger] shop record read failed:", err);
    return null;
  }
}

/**
 * Silently ensure the shop record exists (first sign-in on a fresh
 * project). There is no setup screen: the shop is created with the
 * default identity, behind the same trusted() gate as everything else.
 *
 * The access codes are NOT seeded here. They used to be written into
 * Realtime Database on first run, which meant the plaintext ended up in a
 * database and the default was in the source. Both codes now live only
 * in Firestore `securitySecrets`, written by tools/bootstrap-access.mjs.
 */
export async function ensureShopRecord() {
  const user = getCurrentUser();
  if (!user) throw new AuthError("not-signed-in", friendly("not-signed-in"));

  const b = await storeBridge();
  const fs = b.firestore;
  const ref = shopRef(fs, b.db);
  const now = fs.serverTimestamp();

  try {
    const snap = await fs.getDoc(ref);
    if (snap.exists()) return snap.data();
  } catch (err) {
    /* Best effort: the create below is the real decision. */
    console.warn("[trustx-ledger] shop record probe skipped:", err);
  }

  const doc = {
    ...DEFAULT_SHOP,
    createdAt: now,
    createdBy: user.uid,
    updatedAt: now,
    updatedBy: user.uid,
  };
  try {
    await fs.setDoc(ref, doc);
    return doc;
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
    /* Lost the race — another browser created it first. */
    try {
      const snap = await fs.getDoc(ref);
      return snap.exists() ? snap.data() : null;
    } catch (readErr) {
      return null;
    }
  }
}

/* =========================================================
   Trusted browsers (access grants)
   -----------------------------------------------------------------
   A trusted browser is one that proved the shop code and holds an
   active `accessGrants/{uid}` record in Firestore. There is no
   separate device secret: the anonymous session's uid IS the browser's
   identity, because uid is the only thing firestore.rules can check.
   That is also what makes revocation instant — the console flips
   `active`, and the very next read of the ledger is denied.

   Clearing a browser's site data destroys the session, so the uid is
   gone and that machine needs the code again. That is the same
   behaviour the old IndexedDB device token had, with one authority
   instead of two.
   ========================================================= */

/* How stale a grant's last-seen stamp may get before we spend a write
   on refreshing it. A page open all afternoon updates it at most once
   an hour, which is plenty for "which machines are actually in use". */
const HEARTBEAT_MS = 60 * 60 * 1000;

/**
 * SHA-256 of the normalized code, lowercase hex — exactly what
 * firestore.rules compares against securitySecrets/{scope}.codeHash.
 *
 * The plaintext never leaves this function: it is hashed in the browser
 * and only the digest is written. `tools/bootstrap-access.mjs` hashes
 * the code the same way, so the two agree byte for byte.
 */
export async function hashAccessCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) throw new AuthError("code-invalid", friendly("code-invalid"));
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new AuthError("enrollment-failed", friendly("enrollment-failed"));
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- IndexedDB credential store ---------- */

/* ---------- Browser label (privacy: no IP, no fingerprinting) ---------- */

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

function defaultDeviceLabel() {
  return shortUA(typeof navigator !== "undefined" ? navigator.userAgent : "");
}

function clientInfo() {
  return {
    ua: shortUA(typeof navigator !== "undefined" ? navigator.userAgent : ""),
    lang: (typeof navigator !== "undefined" && navigator.language) || "",
  };
}

/* ---------- Enrollment + management ---------- */

/**
 * Enroll THIS browser as trusted, by proving the shop code.
 *
 * Three steps, and the code is only ever proven in the middle one:
 *
 *   1. sign in anonymously — a session on its own grants nothing;
 *   2. write enrollments/{uid} carrying sha256(code). The rules accept
 *      it only if that hash equals securitySecrets/shop.codeHash, so a
 *      wrong code is denied here and nothing further happens;
 *   3. write accessGrants/{uid}, which the rules allow only while that
 *      proof exists and the caller is not already trusted.
 *
 * Everything is keyed by the caller's own uid, so two browsers enrolling
 * at the same moment cannot collide.
 *
 * @param {object} opts
 * @param {string} opts.code  the typed shop code (never stored)
 * @param {string} [opts.label] a name for this machine in the console
 * @returns {Promise<object>} the access grant
 * @throws {AuthError} code-invalid when the rules refuse the proof
 */
export async function enrollBrowser({ code, label } = {}) {
  const user = await signInAnonymous();
  const b = await storeBridge();
  const fs = b.firestore;

  const codeHash = await hashAccessCode(code);

  /* Step 2 — the server-side code check. */
  try {
    await fs.setDoc(enrollRef(fs, b.db, user.uid), {
      scope: "shop",
      codeHash,
      createdAt: fs.serverTimestamp(),
      createdBy: user.uid,
    });
  } catch (err) {
    if (isPermissionDenied(err)) {
      /* Either the code was wrong or securitySecrets/{scope} does not
         exist yet. The rules cannot tell us which, and deliberately do
         not — but they are the same user action, so one message covers
         both, with the setup case named. */
      throw new AuthError("code-invalid", friendly("code-invalid"));
    }
    throw toAuthError(err);
  }

  /* Step 3 — trade the proof for access. A browser enrolling for the
     first time gets a new grant record; one coming back after a
     revocation already has one, and reactivates it. The rules pin which
     of the two is allowed. */
  const now = fs.serverTimestamp();
  const existing = await getAccessGrant();
  if (existing) {
    try {
      await fs.updateDoc(grantRef(fs, b.db, user.uid), {
        active: true,
        lastUsedAt: now,
        updatedAt: now,
        updatedBy: user.uid,
      });
    } catch (err) {
      console.error("[trustx-ledger] access restore refused:", err);
      throw new AuthError("enrollment-failed", friendly("enrollment-failed"));
    }
    return { ...existing, active: true };
  }

  const grant = {
    active: true,
    role: "shop",
    label: String(label || defaultDeviceLabel()).trim().slice(0, 80) || defaultDeviceLabel(),
    client: clientInfo(),
    lastUsedAt: now,
    createdAt: now,
    createdBy: user.uid,
    updatedAt: now,
    updatedBy: user.uid,
  };
  try {
    await fs.setDoc(grantRef(fs, b.db, user.uid), grant);
  } catch (err) {
    console.error("[trustx-ledger] access grant refused:", err);
    throw new AuthError("enrollment-failed", friendly("enrollment-failed"));
  }

  return grant;
}

/**
 * This browser's own access grant, or null when it has never been
 * enrolled. Reading your own record is always allowed, revoked or not —
 * that is how a browser learns it has been locked out.
 *
 * @returns {Promise<object|null>}
 */
export async function getAccessGrant() {
  const user = getCurrentUser();
  if (!user) return null;
  try {
    const b = await storeBridge();
    const fs = b.firestore;
    const snap = await fs.getDoc(grantRef(fs, b.db, user.uid));
    return snap.exists() ? { uid: snap.id, ...snap.data() } : null;
  } catch (err) {
    /* Offline or rules denied: fail closed. A browser that cannot prove
       it is trusted must not be treated as trusted. */
    console.warn("[trustx-ledger] access grant read failed:", err);
    return null;
  }
}

/**
 * Refresh the grant's last-seen stamp, at most once an hour. This is the
 * one field a browser may move on its own record, and it is display-only
 * — it cannot restore trust or change a role (see firestore.rules).
 */
export async function touchAccessGrant() {
  const user = getCurrentUser();
  if (!user) return;
  try {
    const b = await storeBridge();
    const fs = b.firestore;
    const ref = grantRef(fs, b.db, user.uid);
    const snap = await fs.getDoc(ref);
    if (!snap.exists()) return;
    const last = snap.data().lastUsedAt;
    const millis = last && typeof last.toMillis === "function" ? last.toMillis() : 0;
    if (Date.now() - millis < HEARTBEAT_MS) return;
    await fs.updateDoc(ref, {
      lastUsedAt: fs.serverTimestamp(),
      updatedAt: fs.serverTimestamp(),
      updatedBy: user.uid,
    });
  } catch (err) {
    /* Cosmetic: never let a missed heartbeat interrupt the shop. */
    console.warn("[trustx-ledger] access heartbeat failed:", err);
  }
}

/* ---------- Access management (Developer console) ---------- */

/**
 * Every trusted browser, newest first. Listing the registry is an admin
 * capability in the rules, so a stolen shop code cannot enumerate the
 * shop's machines.
 *
 * @returns {Promise<Array<object & {uid: string}>>}
 */
export async function listAccessGrants() {
  const b = await storeBridge();
  const fs = b.firestore;
  const snap = await fs.getDocs(fs.collection(b.db, "accessGrants"));
  return snap.docs
    .map((d) => ({ uid: d.id, ...d.data() }))
    .sort((a, x) => toMillis(x.createdAt) - toMillis(a.createdAt));
}

/** Revoke a browser's trust (admin grant required; the rules enforce it). */
export async function revokeGrant(uid) {
  return patchGrant(uid, { active: false });
}

/** Reactivate a revoked browser (admin grant required). */
export async function restoreGrant(uid) {
  return patchGrant(uid, true);
}

/** Permanently forget a browser (admin grant required). */
export async function removeGrant(uid) {
  const b = await storeBridge();
  const fs = b.firestore;
  await fs.deleteDoc(grantRef(fs, b.db, uid));
}

async function patchGrant(uid, active) {
  const b = await storeBridge();
  const fs = b.firestore;
  const operator = getCurrentUser();
  if (!operator) throw new AuthError("not-signed-in", friendly("not-signed-in"));
  const ref = grantRef(fs, b.db, uid);
  const snap = await fs.getDoc(ref);
  if (!snap.exists()) throw new AuthError("enrollment-failed", "That browser is no longer registered.");

  const now = fs.serverTimestamp();
  await fs.updateDoc(ref, {
    active,
    lastUsedAt: active === true ? now : snap.data().lastUsedAt,
    updatedAt: now,
    updatedBy: operator.uid,
  });
}

/* =========================================================
   Admin access (the Developer console gate)
   -----------------------------------------------------------------
   The console is not reachable from the public navigation and needs a
   second code. Presenting it writes an ADMIN-scope enrollment proof,
   which the rules verify against securitySecrets/admin, and only then
   may this browser promote its own grant from `shop` to `admin`. That
   promotion is the whole capability split: an admin may list, revoke,
   restore and delete other browsers' grants, and a shop-trusted
   browser may do none of it.

   Note the ordering the rules enforce: a browser must ALREADY hold
   active shop trust to unlock the console, so the admin code alone is
   useless to someone who has not already got into the shop.
   ========================================================= */

/** Does THIS browser hold an active admin grant? */
export async function checkAdminAccess() {
  const grant = await getAccessGrant();
  return Boolean(grant && grant.active === true && grant.role === "admin");
}

/**
 * Exchange the admin code for the admin role on this browser.
 * Throws AuthError("admin-code-invalid") when the rules reject the proof.
 */
export async function grantAdminAccess(code) {
  const user = getCurrentUser();
  if (!user) throw new AuthError("admin-not-trusted", friendly("admin-not-trusted"));

  const current = await getAccessGrant();
  if (!current || current.active !== true) {
    throw new AuthError("admin-not-trusted", friendly("admin-not-trusted"));
  }

  const b = await storeBridge();
  const fs = b.firestore;

  /* An admin-scope proof, checked server-side against
     securitySecrets/admin. A wrong code never lands. */
  try {
    await fs.setDoc(enrollRef(fs, b.db, user.uid), {
      scope: "admin",
      codeHash: await hashAccessCode(code),
      createdAt: fs.serverTimestamp(),
      createdBy: user.uid,
    });
  } catch (err) {
    if (isPermissionDenied(err)) {
      throw new AuthError("admin-code-invalid", friendly("admin-code-invalid"));
    }
    throw new AuthError("admin-grant-failed", friendly("admin-grant-failed"));
  }

  /* Promotion. The rules allow this only from `shop` to `admin`, only
     while active, and only with the proof above on file. */
  const now = fs.serverTimestamp();
  try {
    await fs.updateDoc(grantRef(fs, b.db, user.uid), {
      role: "admin",
      updatedAt: now,
      updatedBy: user.uid,
    });
  } catch (err) {
    console.error("[trustx-ledger] admin promotion rejected:", err);
    throw new AuthError("admin-grant-failed", friendly("admin-grant-failed"));
  }

  return true;
}
