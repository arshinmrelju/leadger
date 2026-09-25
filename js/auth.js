/* =========================================================
   SEVA LEDGER — Authentication & authorization
   -----------------------------------------------------------------
   Single-shop (flat) model. Sign-in (Google / email / access code),
   auth state listener, protected-page handling, membership resolution
   and role helpers. Frontend checks here are CONVENIENCE only — every
   data access is re-validated by firestore.rules server-side.
   ========================================================= */

import { getFirebridge } from "./firebase.js";
import { uid, isValidEmail } from "./utils.js";

export const ROLES = { ADMIN: "ADMIN", EMPLOYEE: "EMPLOYEE" };

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
  "invalid-email": "That email address does not look right.",
  "user-not-found": "No account was found with this email address.",
  "wrong-password": "Incorrect password. Please try again.",
  "invalid-credential": "Email or password is incorrect.",
  "email-already-in-use": "That email is already registered. Try signing in.",
  "weak-password": "Password must be at least 6 characters.",
  "network-request-failed": "Network problem. Check your connection and try again.",
  "popup-closed": "Sign-in window was closed before finishing.",
  "popup-blocked": "The browser blocked the sign-in popup.",
  "operation-not-allowed": "This sign-in method is not enabled for this project yet.",
  "account-exists-with-different-credential": "An account already exists for this email.",
  "too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
  "code-invalid": "That access code is not recognised.",
  "code-lookup-failed": "Could not check the access code.",
  "claim-failed": "Could not link your account. Please try again.",
  "setup-failed": "Could not set up the shop. Please try again.",
  "already-setup": "This shop is already set up for another owner.",
  "member-disabled": "Your account is disabled. Ask an admin to reactivate it.",
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
  if (code === "permission-denied") return new AuthError("already-setup", friendly("already-setup"));

  switch (code) {
    case "auth/invalid-email": return new AuthError("invalid-email", friendly("invalid-email"));
    case "auth/user-not-found":
    case "auth/invalid-login-credentials":
    case "auth/invalid-credential": return new AuthError("invalid-credential", friendly("invalid-credential"));
    case "auth/wrong-password": return new AuthError("wrong-password", friendly("wrong-password"));
    case "auth/email-already-in-use": return new AuthError("email-already-in-use", friendly("email-already-in-use"));
    case "auth/weak-password": return new AuthError("weak-password", friendly("weak-password"));
    case "auth/network-request-failed": return new AuthError("network-request-failed", friendly("network-request-failed"));
    case "auth/popup-closed-by-user": return new AuthError("popup-closed", friendly("popup-closed"));
    case "auth/popup-blocked": return new AuthError("popup-blocked", friendly("popup-blocked"));
    case "auth/operation-not-allowed": return new AuthError("operation-not-allowed", friendly("operation-not-allowed"));
    case "auth/account-exists-with-different-credential":
      return new AuthError("account-exists-with-different-credential", friendly("account-exists-with-different-credential"));
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

export async function signInWithGoogle() {
  try {
    const b = await bridge();
    await b.authMod.signInWithPopup(b.auth, b.googleProvider);
    return getCurrentUser();
  } catch (err) {
    throw toAuthError(err);
  }
}

export async function signInWithEmail(email, password) {
  try {
    const b = await bridge();
    const cred = await b.authMod.signInWithEmailAndPassword(b.auth, String(email).trim(), String(password));
    return cred.user;
  } catch (err) {
    throw toAuthError(err);
  }
}

export async function createAccount(email, password, displayName) {
  try {
    const b = await bridge();
    const cred = await b.authMod.createUserWithEmailAndPassword(b.auth, String(email).trim(), String(password));
    if (displayName) {
      await b.authMod.updateProfile(cred.user, { displayName: String(displayName).trim() });
    }
    return cred.user;
  } catch (err) {
    throw toAuthError(err);
  }
}

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_LENGTH = 8;

/** Normalize a user-typed code: strip spaces, uppercase. */
export function normalizeCode(input) {
  return String(input || "").toUpperCase().replace(/\s+/g, "").trim();
}

/** A random 8-char A-Z0-9 access code (e.g. TRUSTX01). */
export function generateAccessCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Access-code sign in ("sign in on the shop computer").
 * The stored code lives in `settings/security` and is ONLY ever compared
 * server-side; clients never read it. Flow: sign in anonymously if
 * needed -> write an EMPLOYEE membership for self carrying the code.
 * Rules re-verify the code against settings/security.
 * A persistent session keeps the device signed in while on the shop Wi-Fi.
 */
export async function joinWithAccessCode(code) {
  const b = await bridge();
  const fs = b.firestore;
  const c = normalizeCode(code);
  if (!/^[A-Z0-9]{8}$/.test(c)) {
    throw new AuthError("code-invalid", friendly("code-invalid"));
  }

  let user = getCurrentUser() || b.auth.currentUser;
  if (!user) {
    try {
      const cred = await b.authMod.signInAnonymously(b.auth);
      user = cred.user;
    } catch (err) {
      throw toAuthError(err);
    }
  }

  try {
    await fs.setDoc(fs.doc(b.db, "members", user.uid), {
      uid: user.uid,
      name: user.displayName || "",
      email: user.email || "",
      photoURL: user.photoURL || "",
      role: ROLES.EMPLOYEE,
      active: true,
      createdAt: fs.serverTimestamp(),
      updatedAt: fs.serverTimestamp(),
      updatedBy: user.uid,
      addedBy: "access_code",
      joinCode: c,
    });
  } catch (err) {
    if (err instanceof AuthError) throw err;
    if (err && err.code === "permission-denied") throw new AuthError("code-invalid", friendly("code-invalid"));
    throw new AuthError("claim-failed", friendly("claim-failed"));
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
  /* Session is fully auth-owned in the single-shop model. */
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

/* ---------------- Membership (single shop) ---------------- */

/**
 * Resolve this user's situation against the single shop.
 * @returns {Promise<{
 *   state: 'first-run'|'no-access'|'disabled'|'ok',
 *   role: string|null, member: object|null, general: object|null
 * }>}
 */
export async function resolveMembership(user = currentUser) {
  if (!user) return { state: "no-access", role: null, member: null, general: null };
  const b = await bridge();
  const fs = b.firestore;
  const [memberSnap, generalSnap] = await Promise.all([
    fs.getDoc(fs.doc(b.db, "members", user.uid)),
    fs.getDoc(fs.doc(b.db, "settings", "general")),
  ]);

  const member = memberSnap.exists() ? memberSnap.data() : null;
  const general = generalSnap.exists() ? generalSnap.data() : null;

  if (!general) return { state: "first-run", role: null, member, general: null };
  if (!member) return { state: "no-access", role: null, member: null, general };
  if (member.active === false) return { state: "disabled", role: null, member, general };

  const role = member.role === ROLES.ADMIN ? ROLES.ADMIN : ROLES.EMPLOYEE;
  return { state: "ok", role, member, general };
}

export function canAdmin(role) {
  return role === ROLES.ADMIN;
}

/* ---------------- First-run: set up this shop ---------------- */

/**
 * Bootstrap the single shop. Only valid when no settings/general exists
 * yet — the calling user becomes the owner (ADMIN). Rules enforce this
 * atomically; both writes are in one batch.
 */
export async function bootstrapShop({ name, phone = "", address = "" }) {
  const b = await bridge();
  const fs = b.firestore;
  const user = getCurrentUser();
  if (!user) throw new AuthError("not-signed-in", friendly("not-signed-in"));

  const batch = fs.writeBatch(b.db);
  batch.set(fs.doc(b.db, "settings", "general"), {
    name: String(name).trim(),
    phone: String(phone).trim(),
    address: String(address).trim(),
    currency: "INR",
    ownerUid: user.uid,
    active: true,
    createdAt: fs.serverTimestamp(),
    createdBy: user.uid,
  });
  batch.set(fs.doc(b.db, "members", user.uid), {
    uid: user.uid,
    name: user.displayName || "",
    email: user.email || "",
    photoURL: user.photoURL || "",
    role: ROLES.ADMIN,
    active: true,
    createdAt: fs.serverTimestamp(),
    updatedAt: fs.serverTimestamp(),
    updatedBy: user.uid,
    addedBy: "self",
  });
  try {
    await batch.commit();
  } catch (err) {
    if (err && err.code === "permission-denied") throw new AuthError("already-setup", friendly("already-setup"));
    throw new AuthError("setup-failed", friendly("setup-failed"));
  }
}

/* ---------------- Email invitations (admin adds employee) ---------------- */

/** Send a membership invitation by email -> pendingMembers/{email}. */
export async function inviteMember(email) {
  const b = await bridge();
  const fs = b.firestore;
  const e = String(email).trim().toLowerCase();
  if (!e) throw new AuthError("invalid-email", friendly("invalid-email"));
  if (!isValidEmail(e)) throw new AuthError("invalid-email", friendly("invalid-email"));
  await fs.setDoc(fs.doc(b.db, "pendingMembers", e), {
    email: e,
    invitedBy: getCurrentUser()?.uid || "",
    invitedAt: fs.serverTimestamp(),
  });
  return e;
}

/**
 * Claim any pending email invitation for the signed-in user.
 * Creates the member doc (EMPLOYEE) and resolves the invitation.
 * @returns {Promise<number>} number of invitations claimed
 */
export async function claimPendingInvites(user = currentUser) {
  if (!user || !user.email) return 0;
  const b = await bridge();
  const fs = b.firestore;
  const email = user.email.toLowerCase();
  const q = fs.query(fs.collection(b.db, "pendingMembers"), fs.where("email", "==", email));
  const snap = await fs.getDocs(q);
  let claimed = 0;
  for (const d of snap.docs) {
    try {
      const batch = fs.writeBatch(b.db);
      batch.set(fs.doc(b.db, "members", user.uid), {
        uid: user.uid,
        name: user.displayName || "",
        email,
        photoURL: user.photoURL || "",
        role: ROLES.EMPLOYEE,
        active: true,
        createdAt: fs.serverTimestamp(),
        updatedAt: fs.serverTimestamp(),
        updatedBy: user.uid,
        addedBy: "invite",
      });
      batch.delete(fs.doc(b.db, "pendingMembers", email));
      await batch.commit();
      claimed += 1;
    } catch (err) {
      console.warn("[seva-ledger] claim invite failed:", reportError(err));
    }
  }
  return claimed;
}

/* ---------------- Member management (admin only; rules enforce) ---------------- */

export async function listMembers() {
  const b = await bridge();
  const fs = b.firestore;
  const snap = await fs.getDocs(fs.collection(b.db, "members"));
  return snap.docs
    .map((d) => ({ uid: d.id, ...d.data() }))
    .sort((x, y) => String(x.name || x.email).localeCompare(String(y.name || y.email)));
}

export async function listPendingInvites() {
  const b = await bridge();
  const fs = b.firestore;
  const snap = await fs.getDocs(fs.collection(b.db, "pendingMembers"));
  return snap.docs.map((d) => ({ email: d.id, ...d.data() }));
}

export async function setMemberRole(uid, role) {
  const b = await bridge();
  const fs = b.firestore;
  await fs.updateDoc(fs.doc(b.db, "members", uid), {
    role: role === ROLES.ADMIN ? ROLES.ADMIN : ROLES.EMPLOYEE,
    updatedAt: fs.serverTimestamp(),
    updatedBy: getCurrentUser()?.uid || "",
  });
}

export async function setMemberActive(uid, active) {
  const b = await bridge();
  const fs = b.firestore;
  await fs.updateDoc(fs.doc(b.db, "members", uid), {
    active: active === true,
    updatedAt: fs.serverTimestamp(),
    updatedBy: getCurrentUser()?.uid || "",
  });
}

export async function cancelInvite(email) {
  const b = await bridge();
  const fs = b.firestore;
  await fs.deleteDoc(fs.doc(b.db, "pendingMembers", email.toLowerCase()));
}

/* ---------------- Settings ---------------- */

export async function getSettings() {
  const b = await bridge();
  const fs = b.firestore;
  const snap = await fs.getDoc(fs.doc(b.db, "settings", "general"));
  return snap.exists() ? snap.data() : {};
}

export async function updateSettings(patch) {
  const b = await bridge();
  const fs = b.firestore;
  const ref = fs.doc(b.db, "settings", "general");
  await fs.setDoc(ref, { currency: "INR", ...patch, updatedAt: fs.serverTimestamp(), updatedBy: getCurrentUser()?.uid || "" }, { merge: true });
}

/* ---------------- Access code (admin) ---------------- */

/**
 * Set (or change) the shop access code. Writes `settings/security`.
 * Rules ensure only admins can do this and that the code is never
 * readable by employees. The previous code is simply replaced.
 * @returns {Promise<string>} the new code
 */
export async function setAccessCode(code) {
  const c = normalizeCode(code);
  if (!/^[A-Z0-9]{8}$/.test(c)) {
    throw new AuthError("code-invalid", friendly("code-invalid"));
  }
  const b = await bridge();
  const fs = b.firestore;
  await fs.setDoc(fs.doc(b.db, "settings", "security"), {
    accessCode: c,
    updatedAt: fs.serverTimestamp(),
    updatedBy: getCurrentUser()?.uid || "",
  });
  return c;
}

/** The current access code (admin only; rules enforce read). */
export async function getAccessCode() {
  const b = await bridge();
  const fs = b.firestore;
  const snap = await fs.getDoc(fs.doc(b.db, "settings", "security"));
  return snap.exists() ? snap.data().accessCode || "" : "";
}