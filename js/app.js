/* =========================================================
   TrustX Ledger — Shared application layer
   Common init, design-system helpers (toast / modal / loading),
   sidebar + topbar shell behavior, global error handling.
   ========================================================= */

import {
  escapeHtml,
  formatKolkataLong,
  formatINR,
} from "./utils.js";

export const APP = {
  name: "TrustX Ledger",
  version: "0.9.0",
  currency: "INR",
  currencySymbol: "\u20B9",
  timezone: "Asia/Kolkata",
};

/* ---------------- Toast notifications ---------------- */

let toastWrap = null;

function ensureToastWrap() {
  if (toastWrap) return toastWrap;
  toastWrap = document.createElement("div");
  toastWrap.className = "toast-wrap";
  toastWrap.setAttribute("aria-live", "polite");
  document.body.appendChild(toastWrap);
  return toastWrap;
}

export function toast(message, type = "info", duration = 4000) {
  const wrap = ensureToastWrap();
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.innerHTML =
    '<div class="toast-msg"></div>';
  el.querySelector(".toast-msg").textContent = String(message ?? "");
  wrap.appendChild(el);

  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 190);
  };

  el.addEventListener("click", dismiss);
  el.dataset.toastTimer = setTimeout(dismiss, duration);
  return dismiss;
}

/* ---------------- Modals ---------------- */

const openOverlays = [];

function closeOverlay(overlay) {
  overlay.classList.remove("is-open");
  const i = openOverlays.indexOf(overlay);
  if (i !== -1) openOverlays.splice(i, 1);
}

/**
 * Open a modal by overlay id (static markup in the page) or by element.
 */
export function openModal(target) {
  const overlay =
    typeof target === "string" ? document.getElementById(target) : target;
  if (!overlay) return;
  overlay.classList.add("is-open");
  if (!openOverlays.includes(overlay)) openOverlays.push(overlay);
  const focusable = overlay.querySelector(
    "input, select, textarea, button:not(.modal-close):not([disabled])"
  );
  if (focusable) {
    setTimeout(() => focusable.focus(), 60);
  }
}

export function closeModal(target) {
  const overlay =
    typeof target === "string" ? document.getElementById(target) : target;
  if (overlay) closeOverlay(overlay);
}

export function closeAllModals() {
  [...openOverlays].forEach(closeOverlay);
}

/**
 * Promise-based confirmation dialog. Resolve true/false.
 */
export function confirm({ title = "Confirm", message = "", confirmText = "Confirm", cancelText = "Cancel", variant = "danger", loadingText = null } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="modal modal-sm" role="document">
        <div class="modal-header">
          <h3>${escapeHtml(title)}</h3>
          <button type="button" class="modal-close" data-close aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">${message}</div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-cancel>${escapeHtml(cancelText)}</button>
          <button type="button" class="btn btn-${variant}" data-ok>${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    openOverlays.push(overlay);

    const finish = (value) => {
      document.removeEventListener("keydown", onKey, true);
      closeOverlay(overlay);
      overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
      setTimeout(() => overlay.remove(), 250);
      resolve(value);
    };

    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        finish(false);
      }
    };
    document.addEventListener("keydown", onKey, true);

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(false);
    });
    overlay.querySelector("[data-close]").addEventListener("click", () => finish(false));
    overlay.querySelector("[data-cancel]").addEventListener("click", () => finish(false));
    overlay.querySelector("[data-ok]").addEventListener("click", () => {
      const okBtn = overlay.querySelector("[data-ok]");
      if (loadingText) {
        if (okBtn.classList.contains("is-loading")) return;
        okBtn.classList.add("is-loading");
        okBtn.textContent = loadingText;
      }
      finish(true);
    });
  });
}

/* ---------------- Loading state helper ---------------- */

export function setLoading(buttonEl, loading) {
  if (!buttonEl) return;
  if (loading) buttonEl.classList.add("is-loading");
  else buttonEl.classList.remove("is-loading");
  buttonEl.disabled = loading;
}

/* ---------------- Shell behavior ---------------- */

function initShell() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebarBackdrop");

  const openSidebar = () => {
    sidebar?.classList.add("is-open");
    backdrop?.classList.add("is-open");
  };
  const closeSidebar = () => {
    sidebar?.classList.remove("is-open");
    backdrop?.classList.remove("is-open");
  };

  document.querySelectorAll("[data-sidebar-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (sidebar?.classList.contains("is-open")) closeSidebar();
      else openSidebar();
    });
  });
  backdrop?.addEventListener("click", closeSidebar);

  /* Active navigation item */
  const pageName = (location.pathname.split("/").pop() || "dashboard").replace(/\.html$/, "") || "dashboard";
  const activeLink = document.querySelector(`.nav-link[data-nav="${pageName}"]`);
  if (activeLink) activeLink.classList.add("is-active");
  else {
    const bodyPage = document.body.getAttribute("data-page");
    document.querySelector(`.nav-link[data-nav="${bodyPage}"]`)?.classList.add("is-active");
  }

  /* Modules arriving in later builds */
  document.querySelectorAll(".nav-link[data-coming]").forEach((btn) => {
    btn.addEventListener("click", () => {
      toast("This module is coming in a later build.", "info", 3200);
    });
  });

  /* Today's date (India timezone) in the top bar */
  const datePill = document.getElementById("topbarDate");
  if (datePill) datePill.textContent = formatKolkataLong(new Date());
}

/* ---------------- Global keys ---------------- */

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (openOverlays.length) {
      event.preventDefault();
      closeOverlay(openOverlays[openOverlays.length - 1]);
      return;
    }
    const sidebar = document.getElementById("sidebar");
    if (sidebar?.classList.contains("is-open")) {
      sidebar.classList.remove("is-open");
      document.getElementById("sidebarBackdrop")?.classList.remove("is-open");
    }
  }
});

/* ---------------- Modal global delegation ---------------- */

document.addEventListener("click", (event) => {
  const overlay = event.target.closest(".modal-overlay");
  if (!overlay) return;
  if (event.target === overlay) closeOverlay(overlay);
  if (event.target.closest("[data-close]")) closeOverlay(overlay);
});

/* ---------------- Global error handling ---------------- */

const lastGlobalError = new Map();

window.addEventListener("error", (event) => {
  if (!event.error && !event.message) return;
  console.error("[TrustX Ledger]", event.error || event.message);
  const key = String(event.message || (event.error && event.error.message) || "error").slice(0, 80);
  if (lastGlobalError.get(key) && Date.now() - lastGlobalError.get(key) < 5000) return;
  lastGlobalError.set(key, Date.now());
  toast("Something went wrong. Please try again.", "error", 6000);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  console.error("[TrustX Ledger] Unhandled rejection:", reason);
  const message = reason && reason.message ? reason.message : String(reason || "unknown");
  const key = message.slice(0, 80);
  if (lastGlobalError.get(key) && Date.now() - lastGlobalError.get(key) < 5000) return;
  lastGlobalError.set(key, Date.now());
  toast("Something went wrong. Please try again.", "error", 6000);
});

/* ---------------- Re-exports used by pages ---------------- */

export { escapeHtml, formatINR };

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initShell);
} else {
  initShell();
}
