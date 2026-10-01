/* =========================================================
   TrustX Ledger — Sign-in and trusted-browser access
   -----------------------------------------------------------------
   The app opens with Google Sign-In. A Firestore allowlist
   (`allowedUsers/{email}`) controls who may access the shop and
   what role they hold (shop or admin). The allowlist is written
   only by the bootstrap tool (tools/bootstrap-access.mjs) using
   the Admin SDK — no client can read or write it.

   HOW GOOGLE AUTH BECOMES ACCESS (all of it server-side, in firestore.rules)
     1. The browser signs in with Google (popup). Firebase verifies
        the Google credential and issues a Firebase session.
     2. firestore.rules checks the signed-in user's email against
        `allowedUsers/{email}`. If the email is not in the allowlist,
        the enrollment write is denied and nothing is created.
     3. A matching allowlist entry buys accessGrants/{uid} — a
        server-side record that every money rule re-reads on every
        request. A Google session on its own grants nothing, because
        signing in with Google is free and open to anybody.
     4. Revoking a grant in the Developer console locks that browser
        out on its very next request.

   The allowlist is therefore only ever *proven*, never *compared*, on
   the client. The remaining weakness is stated plainly in the README:
   a Google account can still be phished, so Firebase App Check (or
   moving the check into a callable function) is the production
   control for that. What the rules buy is that the ledger is no
   longer open to every Google user in existence.
   ========================================================= */

import { getFirebridge } from "./firebase.js";
import { createReadCache } from "./read-cache.js";
import {
  guardQuota,
  isQuotaExhausted,
  noteReads,
  noteWrites,
  noteDeletes,
  readsForQuery,
} from "./quota.js";

/* ------------------------------------------------------------------
   Free-plan accounting

   Every page load used to spend three reads before it drew anything: this
   browser's grant, the shop record, and a second grant read purely to
   decide whether the hourly heartbeat was due. They are cached here so a
   page refresh costs none of them.

   Caching the GRANT is safe despite it being a trust decision, because it
   is not the thing that enforces trust. firestore.rules re-reads
   accessGrants/{uid} on every single request, so a revoked browser is
   refused by the server on its next request regardless of what this tab
   still believes. What the cache changes is only whether the UI bounces
   the browser to the login screen a few seconds sooner or later. */

const grantCache = createReadCache({
  freshTtlMs: 30_000,
  staleTtlMs: 2 * 60_000,
  onError: (err) => console.warn("[trustx-ledger] access grant refresh failed:", err),
});

const shopCache = createReadCache({
  freshTtlMs: 60_000,
  staleTtlMs: 5 * 60_000,
  onError: (err) => console.warn("[trustx-ledger] shop record refresh failed:", err),
});

/** A counted, quota-classified single-document read. */
function chargedGetDoc(fs, ref) {
  return guardQuota(async () => {
    const snap = await fs.getDoc(ref);
    noteReads(readsForQuery(snap.exists() ? 1 : 0));
    return snap;
  });
}

/** A counted, quota-classified query. */
function chargedGetDocs(fs, query) {
  return guardQuota(async () => {
    const snap = await fs.getDocs(query);
    noteReads(readsForQuery(snap.size));
    return snap;
  });
}

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
  "quota-exhausted":
    "This shop has used up today's free Firebase limit, so nothing can be saved until it resets. Nothing you entered has been lost — try again after the reset.",
  "network-request-failed":
    "Network problem. Check your connection and try again.",
  "operation-not-allowed":
    "Google Sign-In is not enabled for this Firebase project. Enable it under Authentication → Sign-in method.",
  "too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
  "popup-closed": "The Google Sign-In popup was closed before completing.",
  "popup-blocked": "The Google Sign-In popup was blocked. Allow popups for this site and try again.",
  "not-authorized":
    "That Google account is not authorised for this shop. Check with the shop administrator.",
  "no-email":
    "This Google account did not share an email address, so it cannot be checked against the shop's list. Try a different account.",
  "enrollment-failed": "Could not complete sign-in. Please try again.",
  "access-not-ready":
    "This browser is not enrolled yet. Sign in with Google.",
  "access-revoked":
    "This browser's access was revoked. Sign in with Google again.",
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
  /* Checked before the switch below so a spent daily quota is never
     reported as a generic sign-in failure — they need different actions. */
  if (isQuotaExhausted(fbErr)) return new AuthError("quota-exhausted", friendly("quota-exhausted"));

  switch (code) {
    case "auth/network-request-failed": return new AuthError("network-request-failed", friendly("network-request-failed"));
    case "auth/operation-not-allowed": return new AuthError("operation-not-allowed", friendly("operation-not-allowed"));
    case "auth/too-many-requests": return new AuthError("too-many-requests", friendly("too-many-requests"));
    case "auth/popup-closed-by-user": return new AuthError("popup-closed", friendly("popup-closed"));
    case "auth/popup-blocked": return new AuthError("popup-blocked", friendly("popup-blocked"));
    case "auth/cancelled-popup-request": return new AuthError("popup-closed", friendly("popup-closed"));
    default: return new AuthError("unknown", friendly("", code));
  }
}

/* A permission denial is the one error the client genuinely cannot
   explain. Firestore evaluates the rules and answers "denied" without
   naming the clause that failed, so nothing here can recover the real
   cause — and the previous wording made that worse by naming a cause
   that is almost never the one. Telling a shop owner to redeploy the
   rules sends them off to check the deployment while the actual fault
   sits in the shop's own data: a closed business day, or a service that
   was archived or renamed. So the message stops guessing and points at
   the two checks that actually decide it, plus the console.

   Never rewrite these to blame the deployment again without checking
   `firebase deploy --only firestore:rules` first — it prints "already up
   to date" when the live rules already match the repo, which is the
   common case and makes the old advice a dead end. */
const PERMISSION_DENIED = {
  generic:
    "The ledger refused that change. Open the browser console (F12) for the details.",
  sale:
    "The ledger refused the sale. Either this business day is closed, or the service has been archived or renamed. Open the browser console (F12) for the details.",
};

/**
 * Convert any thrown error into a safe, human-readable message string.
 *
 * @param {*} err
 * @param {object}  [opts]
 * @param {string}  [opts.action] a key from PERMISSION_DENIED naming what
 *         was attempted ("sale"), so a refusal can point at the checks
 *         that actually apply to it.
 */
export function reportError(err, { action = "generic" } = {}) {
  if (err instanceof AuthError) return err.message;
  if (err && typeof err.message === "string") {
    if (/^auth\//.test(err.message)) return toAuthError(err).message;
    /* Neither database's raw "Missing or insufficient permissions." is
       ever actionable for the shop user — the rules are the shop's own.
       Firestore says permission-denied, Realtime Database says
       PERMISSION_DENIED, and both mean the same thing here. */
    if (isPermissionDenied(err)) {
      return PERMISSION_DENIED[action] || PERMISSION_DENIED.generic;
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
 * Does NOT create a Google session on its own; that only happens
 * when the user clicks "Sign in with Google".
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

/* ---------------- Sign-in / sign-out ---------------- */

/**
 * Sign in with Google (popup). This is the ONLY sign-in path.
 * Firestore identities the device by uid; the Google credential is
 * kept so the shop computer stays signed in.
 */
export async function signInWithGoogle() {
  const b = await bridge();
  if (currentUser) return currentUser;
  try {
    const provider = new b.authMod.GoogleAuthProvider();
    const cred = await b.authMod.signInWithPopup(b.auth, provider);
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
 * signing in with Google is something anyone can do. This reads the
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
    return await shopCache.read("general", async () => {
      const snap = await chargedGetDoc(fs, shopRef(fs, b.db));
      return snap.exists() ? snap.data() : null;
    });
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
 * The allowlist is NOT seeded here. It is written by tools/bootstrap-access.mjs.
 */
export async function ensureShopRecord() {
  const user = getCurrentUser();
  if (!user) throw new AuthError("not-signed-in", friendly("not-signed-in"));

  const b = await storeBridge();
  const fs = b.firestore;
  const ref = shopRef(fs, b.db);
  const now = fs.serverTimestamp();

  try {
    /* Through the same cache the shell's getGeneral() uses. This runs on
       every single page load, so a fresh probe here would spend a read to
       re-answer a question the rules cannot have changed — and the shell's
       `ensureShopRecord() || getGeneral()` means the cached getGeneral()
       behind it was never actually reached. */
    const existing = await shopCache.read("general", async () => {
      const snap = await chargedGetDoc(fs, ref);
      return snap.exists() ? snap.data() : null;
    });
    if (existing) return existing;
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
    await guardQuota(() => fs.setDoc(ref, doc));
    noteWrites();
    shopCache.drop();
    return doc;
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
    /* Lost the race — another browser created it first. Re-read for real,
       because the cached answer was null a moment ago and is now wrong,
       and remember it so the next page load does not pay for it again. */
    try {
      const snap = await chargedGetDoc(fs, ref);
      const data = snap.exists() ? snap.data() : null;
      shopCache.set("general", data);
      return data;
    } catch (readErr) {
      return null;
    }
  }
}

/* =========================================================
   Trusted browsers (access grants)
   -----------------------------------------------------------------
   A trusted browser is one that signed in with an authorised Google
   account and holds an active `accessGrants/{uid}` record in Firestore.
   There is no separate device secret: the Google session's uid IS the
   browser's identity, because uid is the only thing firestore.rules can
   check. That is also what makes revocation instant — the console flips
   `active`, and the very next read of the ledger is denied.

   Clearing a browser's site data destroys the session, so the uid is
   gone and that machine needs to sign in again. That is the same
   behaviour the old access-code system had, with one authority
   instead of two.
   ========================================================= */

/* How stale a grant's last-seen stamp may get before we spend a write
   on refreshing it. A page open all afternoon updates it at most once
   an hour, which is plenty for "which machines are actually in use". */
const HEARTBEAT_MS = 60 * 60 * 1000;

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
 * Enroll THIS browser as trusted, by proving the Google account is
 * in the allowlist.
 *
 * Three steps, and the allowlist check is only ever done in the middle one:
 *
 *   1. sign in with Google — a session on its own grants nothing;
 *   2. write enrollments/{uid} carrying the user's email. The rules
 *      accept it only if that email exists in allowedUsers, so an
 *      unauthorised account is denied here and nothing further happens;
 *   3. write accessGrants/{uid}, which the rules allow only while that
 *      proof exists and the caller is not already trusted.
 *
 * Everything is keyed by the caller's own uid, so two browsers enrolling
 * at the same moment cannot collide.
 *
 * @param {object} opts
 * @param {string} [opts.label] a name for this machine in the console
 * @returns {Promise<object>} the access grant
 * @throws {AuthError} not-authorized when the rules refuse the proof
 */
export async function enrollBrowser({ label } = {}) {
  const user = await signInWithGoogle();
  const b = await storeBridge();
  const fs = b.firestore;

  const email = (user.email || "").toLowerCase().trim();

  /* The rules pin the proof's email to the address Firebase verified on
     the ID token, so an account that arrived without one can never be
     allowed. Say so here rather than letting the write be refused and
     reported as "not authorised", which sends the shop looking for an
     allowlist entry that would not have helped. */
  if (!email) throw new AuthError("no-email", friendly("no-email"));

  /* Step 2 — the server-side allowlist check. */
  try {
    await guardQuota(() =>
      fs.setDoc(enrollRef(fs, b.db, user.uid), {
        scope: "shop",
        email,
        createdAt: fs.serverTimestamp(),
        createdBy: user.uid,
      })
    );
    noteWrites();
  } catch (err) {
    if (isPermissionDenied(err)) {
      /* Either the email is not in allowedUsers or the allowlist
         entry does not exist yet. The rules cannot tell us which, and
         deliberately do not — but they are the same user action, so
         one message covers both. */
      throw new AuthError("not-authorized", friendly("not-authorized"));
    }
    throw toAuthError(err);
  }

  /* Step 3 — trade the proof for access. A browser enrolling for the
     first time gets a new grant record; one coming back after a
     revocation already has one, and reactivates it. The rules pin which
     of the two is allowed. */
  const now = fs.serverTimestamp();
  /* Forced, deliberately. The cached answer to "does this browser already
     have a grant?" is exactly the decision this line makes, and it is
     written fresh a moment ago by the sign-in that brought the user here —
     so a cached `null` from the pre-login check would send an enrolling
     browser down the create path, the rules would refuse it as an existing
     record, and the shop would be told "not authorised" about an account
     that is on the allowlist. */
  const existing = await getAccessGrant({ force: true });
  if (existing) {
    try {
      await guardQuota(() =>
        fs.updateDoc(grantRef(fs, b.db, user.uid), {
          active: true,
          lastUsedAt: now,
          updatedAt: now,
          updatedBy: user.uid,
        })
      );
      noteWrites();
      grantCache.drop(user.uid);
    } catch (err) {
      console.error("[trustx-ledger] access restore refused:", err);
      throw toAuthError(err);
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
    await guardQuota(() => fs.setDoc(grantRef(fs, b.db, user.uid), grant));
    noteWrites();
    grantCache.drop(user.uid);
  } catch (err) {
    console.error("[trustx-ledger] access grant refused:", err);
    throw toAuthError(err);
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
export async function getAccessGrant({ force = false } = {}) {
  const user = getCurrentUser();
  if (!user) return null;
  try {
    const b = await storeBridge();
    const fs = b.firestore;
    return await grantCache.read(
      user.uid,
      async () => {
        const snap = await chargedGetDoc(fs, grantRef(fs, b.db, user.uid));
        return snap.exists() ? { uid: snap.id, ...snap.data() } : null;
      },
      { force }
    );
  } catch (err) {
    /* Offline, quota spent, or rules denied: fail closed. A browser that
       cannot prove it is trusted must not be treated as trusted. */
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
    /* The heartbeat exists to keep a "last seen" column roughly current,
       so if the cached grant already says it was touched within the hour
       the answer is already known and the probe read is pure cost. */
    const known = await getAccessGrant();
    const millis = known ? toMillis(known.lastUsedAt) : 0;
    if (Date.now() - millis < HEARTBEAT_MS) return;

    const b = await storeBridge();
    const fs = b.firestore;
    const ref = grantRef(fs, b.db, user.uid);
    const snap = await chargedGetDoc(fs, ref);
    if (!snap.exists()) return;
    const last = snap.data().lastUsedAt;
    const lastMillis = last && typeof last.toMillis === "function" ? last.toMillis() : 0;
    if (Date.now() - lastMillis < HEARTBEAT_MS) return;
    await guardQuota(() =>
      fs.updateDoc(ref, {
        lastUsedAt: fs.serverTimestamp(),
        updatedAt: fs.serverTimestamp(),
        updatedBy: user.uid,
      })
    );
    noteWrites();
    grantCache.drop(user.uid);
  } catch (err) {
    /* Cosmetic: never let a missed heartbeat interrupt the shop. */
    console.warn("[trustx-ledger] access heartbeat failed:", err);
  }
}

/* ---------- Access management (Developer console) ---------- */

/**
 * Every trusted browser, newest first. Listing the registry is an admin
 * capability in the rules, so an unauthorised Google account cannot
 * enumerate the shop's machines.
 *
 * @returns {Promise<Array<object & {uid: string}>>}
 */
export async function listAccessGrants() {
  const b = await storeBridge();
  const fs = b.firestore;
  const snap = await chargedGetDocs(fs, fs.collection(b.db, "accessGrants"));
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
  await guardQuota(() => fs.deleteDoc(grantRef(fs, b.db, uid)));
  noteDeletes();
  grantCache.drop(uid);
}

async function patchGrant(uid, active) {
  const b = await storeBridge();
  const fs = b.firestore;
  const operator = getCurrentUser();
  if (!operator) throw new AuthError("not-signed-in", friendly("not-signed-in"));
  const ref = grantRef(fs, b.db, uid);
  const snap = await chargedGetDoc(fs, ref);
  if (!snap.exists()) throw new AuthError("enrollment-failed", "That browser is no longer registered.");

  const now = fs.serverTimestamp();
  await guardQuota(() =>
    fs.updateDoc(ref, {
      active,
      lastUsedAt: active === true ? now : snap.data().lastUsedAt,
      updatedAt: now,
      updatedBy: operator.uid,
    })
  );
  noteWrites();
  grantCache.drop(uid);
}

/* =========================================================
   Admin access (the Developer console gate)
   -----------------------------------------------------------------
   The console is not reachable from the public navigation and needs
   an admin role. The allowlist entry for the user's email determines
   the role: if the email maps to 'admin', the enrollment proof carries
   admin scope and the grant is minted with role 'admin'. That
   promotion is the whole capability split: an admin may list, revoke,
   restore and delete other browsers' grants, and a shop-trusted
   browser may do none of it.

   Note the ordering the rules enforce: a browser must ALREADY hold
   active shop trust to unlock the console, so an admin email alone is
   useless to someone who has not already got into the shop.
   ========================================================= */

/**
 * Ask the rules whether THIS account is an admin, and if so, promote this
 * browser's grant to admin.
 *
 * There is deliberately no local "am I an admin?" helper here. The console
 * already holds this browser's own grant — js/shell.js reads it once to
 * build `ctx.isAdmin` — so a second read would only restate it, and this
 * module is the wrong place to answer the question anyway: the allowlist is
 * unreadable by any client, so the ONLY authority on whether an address
 * carries the admin role is firestore.rules.
 *
 * The answer arrives as a verdict on the write rather than as a value: the
 * admin-scope proof below is accepted only when the signed-in account's own
 * verified address is on the allowlist with the admin role. A shop account
 * is refused, whether by name (the proof's email must equal the token's) or
 * by role (a `shop` entry may not prove `admin`). Callers therefore get
 * `true` or an AuthError — "not-authorized" being the ordinary answer for
 * somebody who is not an admin, and not an error worth reporting as one.
 */
export async function grantAdminAccess() {
  const user = getCurrentUser();
  if (!user) throw new AuthError("not-signed-in", friendly("not-signed-in"));

  const current = await getAccessGrant();
  if (!current || current.active !== true) {
    throw new AuthError("access-not-ready", friendly("access-not-ready"));
  }

  const b = await storeBridge();
  const fs = b.firestore;

  const email = (user.email || "").toLowerCase().trim();

  /* An admin-scope proof, checked server-side against
     allowedUsers/{email}. An unauthorised email never lands. */
  try {
    await guardQuota(() =>
      fs.setDoc(enrollRef(fs, b.db, user.uid), {
        scope: "admin",
        email,
        createdAt: fs.serverTimestamp(),
        createdBy: user.uid,
      })
    );
    noteWrites();
  } catch (err) {
    if (isPermissionDenied(err)) {
      throw new AuthError("not-authorized", friendly("not-authorized"));
    }
    throw toAuthError(err);
  }

  /* Promotion. The rules allow this only from `shop` to `admin`, only
     while active, and only with the proof above on file. */
  const now = fs.serverTimestamp();
  try {
    await guardQuota(() =>
      fs.updateDoc(grantRef(fs, b.db, user.uid), {
        role: "admin",
        updatedAt: now,
        updatedBy: user.uid,
      })
    );
    noteWrites();
    grantCache.drop(user.uid);
  } catch (err) {
    console.error("[trustx-ledger] admin promotion rejected:", err);
    throw toAuthError(err);
  }

  return true;
}
