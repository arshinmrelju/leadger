/* =========================================================
   SEVA LEDGER — Protected-page shell bootstrap
   -----------------------------------------------------------------
   Shared by dashboard.html and transactions.html. Owns:
     - auth guard + session-loss redirect
     - membership resolution (first-run / join / disabled / ok)
     - user chip + shop name + date + sync pill
     - online/offline listeners and Kolkata day rollover
     - Ctrl/Cmd+N "new transaction" shortcut
   Pages call initAppShell(...) and receive a rendering context when
   the user is an ACTIVE member. Everything else is handled here.
   ========================================================= */

import { toast, confirm, setSyncState } from "./app.js";
import { escapeHtml, formatKolkataLong, todayKolkata } from "./utils.js";
import {
  requireAuth,
  guardPage,
  getCurrentUser,
  onAuthStateChange,
  signOut,
  claimPendingInvites,
  resolveMembership,
  bootstrapShop,
  joinWithAccessCode,
  canAdmin,
  roleLabel,
  reportError,
  ROLES,
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

function renderUserChip(user, state) {
  const chip = document.getElementById("userChip");
  if (!chip) return;
  const role = state ? state.role : null;
  const roleLabelText = roleLabel(role);
  const roleBadge =
    role === ROLES.ADMIN
      ? '<span class="role-badge role-badge-admin">' + roleLabelText + "</span>"
      : role === ROLES.EMPLOYEE
        ? '<span class="role-badge role-badge-employee">' + roleLabelText + "</span>"
        : "";
  chip.innerHTML =
    '<div class="user-chip">' +
    (user.photoURL
      ? '<span class="user-avatar"><img src="' + escapeHtml(user.photoURL) + '" alt="" /></span>'
      : '<span class="user-avatar">' + escapeHtml(initialsOf(user.displayName, user.email)) + "</span>") +
    '<div class="user-meta">' +
    '<div class="user-name">' + escapeHtml(user.displayName || (user.isAnonymous ? "Shop user" : user.email || "User")) + "</div>" +
    '<div class="user-sub">' + escapeHtml(user.email || "") + (roleBadge ? "&nbsp;&nbsp;" + roleBadge : "") + "</div>" +
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

  if (state && state.general) {
    const shop = document.getElementById("topbarShop");
    if (shop) {
      shop.style.display = "";
      shop.textContent = state.general.name || "Shop";
    }
  }
}

function renderSetup() {
  const mainContent = document.getElementById("mainContent");
  if (!mainContent) return;
  mainContent.innerHTML =
    '<div class="card onboarding" style="max-width:560px;margin:2rem auto;">' +
    '<div class="card-header"><h3>Welcome — set up your shop</h3></div>' +
    '<div class="card-body">' +
    '<p class="small muted">This is the first account for this shop, so you will be its owner (an admin). ' +
    "Name your shop to continue.</p>" +
    '<form id="setupForm" novalidate>' +
    '<div class="field"><label for="shopName">Shop name *</label>' +
    '<input class="input input-lg" id="shopName" type="text" maxlength="80" required placeholder="e.g. Akshya Digital Solutions" /></div>' +
    '<div class="form-row">' +
    '<div class="field"><label for="shopPhone">Phone</label>' +
    '<input class="input" id="shopPhone" type="tel" maxlength="20" inputmode="tel" placeholder="Phone number" /></div>' +
    '<div class="field"><label for="shopAddress">Address</label>' +
    '<input class="input" id="shopAddress" type="text" maxlength="300" placeholder="Address" /></div>' +
    "</div>" +
    '<button type="submit" class="btn btn-primary btn-lg btn-block" id="setupBtn">Set up this shop</button>' +
    "</form></div></div>";

  document.getElementById("setupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.getElementById("shopName").value.trim();
    if (!name) {
      toast("Enter a shop name.", "error");
      return;
    }
    const btn = document.getElementById("setupBtn");
    btn.classList.add("is-loading");
    btn.disabled = true;
    try {
      await bootstrapShop({
        name,
        phone: document.getElementById("shopPhone").value.trim(),
        address: document.getElementById("shopAddress").value.trim(),
      });
      toast("Shop set up. Welcome!", "success");
      window.location.reload();
    } catch (err) {
      btn.classList.remove("is-loading");
      btn.disabled = false;
      toast(reportError(err), "error");
    }
  });
}

function renderJoin() {
  const mainContent = document.getElementById("mainContent");
  if (!mainContent) return;
  mainContent.innerHTML =
    '<div class="card onboarding" style="max-width:520px;margin:2rem auto;">' +
    '<div class="card-header"><h3>Join this shop</h3></div>' +
    '<div class="card-body">' +
    '<p class="small muted">Your account is signed in but not linked to this shop yet. ' +
    "If the owner invited you by email, sign in with that email. " +
    "Otherwise enter the shop access code shown to staff.</p>" +
    '<form id="joinForm" novalidate>' +
    '<div class="field"><label for="joinCodeInput">Shop access code</label>' +
    '<input class="input code-input" id="joinCodeInput" type="password" maxlength="32" autocomplete="one-time-code" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;" />' +
    "</div>" +
    '<button type="submit" class="btn btn-primary btn-lg btn-block" id="joinBtn">Join shop</button>' +
    "</form></div></div>";

  document.getElementById("joinForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = document.getElementById("joinCodeInput").value.trim();
    if (!code) {
      toast("Enter the shop access code.", "error");
      return;
    }
    const btn = document.getElementById("joinBtn");
    btn.classList.add("is-loading");
    btn.disabled = true;
    try {
      await joinWithAccessCode(code);
      toast("Welcome! You are now an employee of this shop.", "success");
      window.location.reload();
    } catch (err) {
      toast(reportError(err), "error");
      btn.classList.remove("is-loading");
      btn.disabled = false;
    }
  });
}

function renderDisabled() {
  const mainContent = document.getElementById("mainContent");
  if (mainContent) {
    mainContent.innerHTML = shield(
      '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
      "Account disabled",
      "Your shop account is currently disabled. Ask an admin to reactivate it.",
      '<button type="button" class="btn btn-secondary" onclick="window.location.reload()">Check again</button>'
    );
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

  const apply = () => {
    setSyncState(navigator.onLine ? "online" : "offline");
  };
  apply();
  window.addEventListener("online", apply);
  window.addEventListener("offline", apply);

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
      const isTxnPage = /transactions\.html$/i.test(window.location.pathname);
      if (isTxnPage) {
        window.dispatchEvent(new CustomEvent("seva:new-txn"));
      } else {
        window.location.href = "transactions.html";
      }
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

  const real = getCurrentUser() || user;
  renderUserChip(real, null);

  try {
    /* Claim any email invitations sent to this account. */
    await claimPendingInvites(real);
    const res = await resolveMembership(real);

    if (res.state === "first-run") {
      renderUserChip(real, null);
      renderSetup();
      return;
    }
    if (res.state === "no-access") {
      renderUserChip(real, null);
      renderJoin();
      return;
    }
    if (res.state === "disabled") {
      renderUserChip(real, null);
      renderDisabled();
      return;
    }

    renderUserChip(real, res);
    wireConnection(typeof onDayChange === "function" ? onDayChange : null);

    setSyncState(navigator.onLine ? "online" : "offline");

    /* Role-gated nav items (e.g. the Admin/developer console). */
    document.querySelectorAll("[data-admin-only]").forEach((el) => {
      el.hidden = !canAdmin(res.role);
    });

    const ctx = {
      user: real,
      role: res.role,
      member: res.member,
      general: res.general,
      isAdmin: canAdmin(res.role),
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