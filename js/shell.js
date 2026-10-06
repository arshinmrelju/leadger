/* =========================================================
   TrustX Ledger — Protected-page shell bootstrap
   -----------------------------------------------------------------
   Shared by dashboard.html, transactions.html, ledger.html,
   calendar.html and admin.html. Owns:
     - auth guard + session-loss redirect
     - optional admin-grant check for the Developer console
     - default service catalog seed (so quick entry is never empty)
     - user chip + shop name + date pill
     - Kolkata day rollover
     - the phone tab bar (bottom navigation under 1024px)
     - Ctrl/Cmd+N "new transaction" shortcut
   Pages call initAppShell(...) and receive a rendering context once
   the session is active.
   ========================================================= */

import { toast, confirm } from "./app.js";
import { escapeHtml, formatKolkataLong, todayKolkata } from "./utils.js";
import { ensureCatalogSeeded } from "./ledger.js";
import { mountPwaControls } from "./pwa.js";
import {
  requireAccess,
  guardPage,
  getCurrentUser,
  signOut,
  ensureShopRecord,
  getGeneral,
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

function renderUserChip(user, loginPage = "login.html") {
  const chip = document.getElementById("userChip");
  if (!chip) return;
  const name = user.displayName || user.email || "Shop user";
  chip.innerHTML =
    '<div class="user-chip">' +
    (user.photoURL
      ? '<span class="user-avatar"><img src="' + escapeHtml(user.photoURL) + '" alt="" /></span>'
      : '<span class="user-avatar">' + escapeHtml(initialsOf(name, user.email)) + "</span>") +
    '<div class="user-meta">' +
    '<div class="user-name">' + escapeHtml(name) + "</div>" +
    '<div class="user-sub">' + escapeHtml(user.email || "Signed in with Google") + "</div>" +
    "</div>" +
    '<button class="user-logout" type="button" id="logoutBtn" aria-label="Sign out" title="Sign out">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>' +
    "</button>" +
    "</div>";

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    const ok = await confirm({
      title: "Sign out",
      message: "Are you sure you want to sign out of TrustX Ledger?",
      confirmText: "Sign out",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await signOut();
    } catch (err) {
      console.error(err);
    }
    window.location.replace(loginPage + "?reason=signedout");
  });
}

function renderShopName(general) {
  const shop = document.getElementById("topbarShop");
  if (shop && general) {
    shop.style.display = "";
    const name = (general.name || "").trim();
    shop.textContent = (!name || name.toUpperCase() === "SEVA LEDGER") ? "TrustX Ledger" : name;
  }
}

function renderFatal(err) {
  const mainContent = document.getElementById("mainContent");
  if (!mainContent) return;
  console.error("[trustx-ledger] shell:", err);
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
          console.error("[trustx-ledger] day rollover:", err);
        }
      }
    }
  }, 60000);
}

/**
 * Put the install and update controls in the topbar.
 *
 * Rendered from JS rather than written into each page's HTML: the same
 * topbar is duplicated across four pages, and a control that has to be
 * remembered in four places is one that will eventually be missing from
 * one of them. The buttons start hidden and reveal themselves when the
 * browser actually has something to offer — see js/pwa.js.
 */
function mountPwaChrome() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  mountPwaControls(topbar);
}

/* ------------------------------------------------------------------
   The phone tab bar
   ------------------------------------------------------------------
   Below 1024px the sidebar is off-canvas behind a hamburger in the top
   LEFT corner, which on a phone is the hardest place on the screen to
   reach with the thumb that is holding the phone. This puts the four
   places the shop actually goes at the bottom instead, where the other
   thumb already is.

   BUILT HERE, NOT WRITTEN INTO EACH PAGE
   The sidebar is duplicated across four pages, which is exactly why a
   control that has to be remembered in four places eventually goes
   missing from one of them. So the bar is assembled from the single list
   below and the active tab is read off <body data-page>, which every page
   already sets. Adding a tab is a one-line change here and nowhere else.

   It is a fast path, not the only path: the sidebar keeps Customers,
   Expenses, Reports, the user chip and Sign out, so the hamburger stays
   on phones. Only the four destinations that earn a tab get one.

   The bar is hidden above 1024px by css/mobile.css, so on a desktop
   window this is inert markup.
   ------------------------------------------------------------------ */

const TAB_BAR = [
  {
    id: "dashboard",
    label: "Today",
    href: "dashboard.html",
    icon:
      '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/>' +
      '<rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
  },
  {
    id: "ledger",
    label: "Day",
    href: "ledger.html",
    icon:
      '<path d="M4 4h16v16H4z"/><path d="M4 8h16"/><path d="M8 12h8"/><path d="M8 16h5"/>',
  },
  {
    id: "transactions",
    label: "Sales",
    href: "transactions.html",
    icon: '<path d="M7 17h10"/><path d="M4 5h16v14H4z"/><path d="M4 5l2-2h12l2 2"/>',
  },
  {
    id: "calendar",
    label: "Month",
    href: "calendar.html",
    icon:
      '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  },
];

function mountTabBar() {
  if (typeof document === "undefined" || !document.body) return;
  /* The auth and offline pages have no shell and nowhere to navigate to,
     so they get no bar. The presence of the sidebar is the real test of
     "this is a shell page" — it is what admin.html has too, and the
     Developer console deserves the same quick way back out. */
  if (!document.querySelector(".sidebar")) return;
  /* admin.html ships its own in-sheet quick nav (.fin-tabbar). Mounting the
     shell's fixed tab bar on top of it would cover it, and every tap meant
     for a console section would land on one of these page links instead. */
  if (document.querySelector(".fin-tabbar")) return;

  const page = document.body.dataset.page || "";

  const nav = document.createElement("nav");
  nav.className = "tabbar";
  nav.setAttribute("aria-label", "Sections");
  /* Two navs with the same label would be ambiguous to a screen reader;
     the sidebar's own label already says "Main navigation". */
  nav.setAttribute("data-mobile-only", "true");

  nav.innerHTML = TAB_BAR.map((tab) => {
    const active = tab.id === page;
    return (
      '<a class="tabbar-link' + (active ? " is-active" : "") + '"' +
      ' href="' + tab.href + '"' +
      ' data-tab="' + tab.id + '"' +
      (active ? ' aria-current="page"' : "") +
      ">" +
      '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      tab.icon +
      "</svg>" +
      "<span>" + tab.label + "</span>" +
      "</a>"
    );
  }).join("");

  document.body.appendChild(nav);
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
 *
 * `requireAccess` is the gate: it needs both a session AND an active
 * access grant, so a browser that was revoked in the Developer console
 * never reaches the render — and even if it skipped this, the money
 * rules would refuse it anyway.
 *
 * @param {object} opts
 * @param {Function} opts.onReady  async (ctx) => render the page
 * @param {Function} [opts.onDayChange]  called when the Kolkata business day rolls over
 * @param {boolean} [opts.requireAdmin]  also resolve the Developer-console
 *        admin role into ctx.isAdmin (one extra read, console only)
 */
export async function initAppShell({ onReady, onDayChange, requireAdmin = false, loginPage = "login.html" } = {}) {
  const grant = await requireAccess(loginPage);
  if (!grant) return; // redirect handled inside requireAccess

  guardPage(loginPage);
  registerGlobalKeys();

  const real = getCurrentUser();
  renderUserChip(real, loginPage);

  try {
    /* Every signed-in browser shares the shop; create its record once. */
    const general = (await ensureShopRecord()) || (await getGeneral());

    /* A shop that has never sold anything still needs its counter's
       services, so the default catalog is seeded here — before the first
       render, which is what stops the quick-service grids from painting
       empty. It is a no-op (one read) once the catalog is in place, and
       it never throws: a shop whose catalog read fails still gets a
       working page. */
    await ensureCatalogSeeded();

    renderShopName(general);
    wireConnection(typeof onDayChange === "function" ? onDayChange : null);
    mountPwaChrome();
    mountTabBar();

    const ctx = {
      user: real,
      general,
      /* This browser's own access record (uid, role, label, last seen). */
      grant,
      /* True only for a browser holding role == 'admin'. Pages that do
         not ask for it never pay for the read. */
      isAdmin: requireAdmin ? grant.role === "admin" : false,
    };
    await onReady(ctx);
  } catch (err) {
    renderFatal(err);
  }
}