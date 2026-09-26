/* =========================================================
   SEVA LEDGER — Protected-page shell bootstrap
   -----------------------------------------------------------------
   Shared by dashboard.html, transactions.html and admin.html. Owns:
     - auth guard + session-loss redirect
     - trusted-device gate (revocation enforced even with a session)
     - user chip + shop name + date pill
     - Kolkata day rollover
     - Ctrl/Cmd+N "new transaction" shortcut
   Pages call initAppShell(...) and receive a rendering context once
   the trusted-device session is active.
   ========================================================= */

import { toast, confirm } from "./app.js";
import { escapeHtml, formatKolkataLong, todayKolkata, debounce } from "./utils.js";
import {
  requireAuth,
  guardPage,
  getCurrentUser,
  onAuthStateChange,
  signOut,
  ensureShopRecord,
  getGeneral,
  checkTrustedDevice,
  updateDeviceLastUsed,
  reportError,
} from "./auth.js";

function shield(icon, title, text, actionsHtml) {
  return (
    '<div class="state card" style="max-width:520px;margin:2rem auto;padding:2rem;">' +
    '<svg class="state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    icon +
    "</svg>" +
    "<h3>" + escapeHtml(title) + "</h3>" +
    "<p>" + escapeHtml(text) + "</p>" +
    (actionsHtml || "") +
    "</div>"
  );
}

function initialsOf(name, email) {
  const src = name || email || "?";
  return src
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0] || "")
    .join("")
    .toUpperCase() || "?";
}

function renderUserChip(user) {
  const chip = document.getElementById("userChip");
  if (!chip) return;
  const name = user.displayName || (user.isAnonymous ? "Shop user" : user.email || "User");
  chip.innerHTML =
    '<div class="user-chip">' +
    (user.photoURL
      ? '<span class="user-avatar"><img src="' + escapeHtml(user.photoURL) + '" alt="" /></span>'
      : '<span class="user-avatar">' + escapeHtml(initialsOf(name, user.email)) + "</span>") +
    '<div class="user-meta">' +
    '<div class="user-name">' + escapeHtml(name) + "</div>" +
    '<div class="user-sub">' + escapeHtml(user.email || "Signed in with shop code") + "</div>" +
    "</div>" +
    '<button class="user-logout" type="button" id="logoutBtn" aria-label="Sign out" title="Sign out">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>' +
    "</button>" +
    "</div>";

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    const ok = await confirm({
      title: "Sign out",
      message: "Are you sure you want to sign out of SEVA LEDGER?",
      confirmText: "Sign out",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await signOut();
    } catch (err) {
      console.error(err);
    }
    window.location.replace("login.html?reason=signedout");
  });
}

function renderShopName(general) {
  const shop = document.getElementById("topbarShop");
  if (shop && general) {
    shop.style.display = "";
    shop.textContent = general.name || "SEVA LEDGER";
  }
}

function renderFatal(err) {
  const mainContent = document.getElementById("mainContent");
  if (!mainContent) return;
  console.error("[seva-ledger] shell:", err);
  mainContent.innerHTML = shield(
    '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    "Something went wrong",
    reportError(err),
    '<button type="button" class="btn btn-secondary" onclick="window.location.reload()">Retry</button>'
  );
}

function wireConnection(onDayChange) {
  const datePill = document.getElementById("topbarDate");
  if (datePill) datePill.textContent = formatKolkataLong(new Date());

  /* Roll the day over when the business day changes (Kolkata). */
  let lastDayKey = todayKolkata();
  setInterval(() => {
    const dayKey = todayKolkata();
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      if (datePill) datePill.textContent = formatKolkataLong(new Date());
      if (typeof onDayChange === "function") {
        try {
          onDayChange();
        } catch (err) {
          console.error("[seva-ledger] day rollover:", err);
        }
      }
    }
  }, 60000);
}

function registerGlobalKeys() {
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && (event.key === "n" || event.key === "N")) {
      event.preventDefault();
      /* The record-a-sale dialog listens for this and opens itself, so
         the shortcut works the same on every page. */
      window.dispatchEvent(new CustomEvent("seva:new-txn"));
    }
  });
}

/**
 * Boot a protected page.
 * @param {object} opts
 * @param {string} [opts.page]   page name for the active nav (auto-detected otherwise)
 * @param {Function} opts.onReady  async (ctx) => render the page
 * @param {Function} [opts.onDayChange]  called when the Kolkata business day rolls over
 */
export async function initAppShell({ onReady, onDayChange } = {}) {
  const user = await requireAuth();
  if (!user) return; // redirect handled inside requireAuth

  guardPage("login.html");
  registerGlobalKeys();

  /* Trust gate: a protected page must belong to an active trusted
     device — even when a session exists. A revoked device still has a
     persisted anonymous session, so this check (not the auth state) is
     what forces it to the code screen. */
  const trust = await checkTrustedDevice();
  if (!trust.trusted) {
    window.location.replace("login.html?reason=untrusted");
    return;
  }

  const real = getCurrentUser() || user;
  renderUserChip(real);

  try {
    /* Every signed-in device shares the shop; create its record once. */
    const general = (await ensureShopRecord()) || (await getGeneral());

    renderShopName(general);
    wireConnection(typeof onDayChange === "function" ? onDayChange : null);

    /* Fire-and-forget heartbeat so the admin device list stays fresh. */
    const beat = debounce(() => updateDeviceLastUsed(trust.tokenHash), 400);
    beat();
    setInterval(beat, 5 * 60 * 1000);

    const ctx = {
      user: real,
      general,
      isAdmin: true,
      trust,
    };
    await onReady(ctx);
  } catch (err) {
    renderFatal(err);
  }
}

/* Redirect to login if the session disappears on this page. */
onAuthStateChange((u) => {
  if (!u && !window.location.pathname.endsWith("login.html")) {
    window.location.replace("login.html");
  }
});