/* =========================================================
   TrustX Ledger — Install, update and offline support
   -----------------------------------------------------------------
   The page-side half of sw.js. Registers the worker, keeps the shop informed
   when a new version is waiting, and exposes the browser's own install prompt
   as a single button.

   THE INSTALL PROMPT CAN BE USED EXACTLY ONCE
   `beforeinstallprompt` fires once per page load and, once `prompt()` has
   been called, that event is spent — it will not fire again for this page,
   and calling it twice does nothing. So it is captured here at startup and
   held, and the button reads from that held value instead of listening for
   the event later. That difference is the whole reason the install button
   works on its first click instead of being mysteriously dead.

   WHY UPDATES ASK INSTEAD OF APPLYING
   A deploy changes the client's write path, and the money rules live on the
   server. Reloading mid-sale would swap one version of that code for another
   underneath a half-filled form, which is the precise mismatch
   firestore.rules exists to reject. So a waiting worker is announced quietly
   in the topbar and applied only when the shopkeeper presses it.

   WHY THE PROMPTS LIVE IN THE TOPBAR
   Both are non-modal. An update prompt that popped a dialog over a
   half-entered sale would cost more than the staleness it warns about, and
   the quota banner already established that this app's warnings belong where
   they can be read and then get out of the way.
   ========================================================= */

import { openModal, closeModal } from "./app.js";

/** Kept until the button is pressed. See the note above. */
let deferredInstallPrompt = null;

/** The waiting worker, if a deploy left one. */
let waitingWorker = null;

const ICON_DOWNLOAD =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/>' +
  '<line x1="12" y1="15" x2="12" y2="3"/></svg>';

const ICON_REFRESH =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';

/** True once running inside the installed app window. */
function isInstalled() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    /* Safari, and older desktop browsers, only set this one. */
    window.navigator.standalone === true
  );
}

/**
 * Register the service worker.
 *
 * Safe to call more than once, and safe on a browser with no service worker
 * support at all: every step is feature-detected, because the app must never
 * fail to boot over an enhancement to being offline.
 *
 * @param {object} [opts]
 * @param {(info: {needsUpdate: boolean}) => void} [opts.onUpdateReady]
 *        called when a new version is waiting for the shopkeeper's approval
 */
export function registerServiceWorker({ onUpdateReady } = {}) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost") {
    /* Service workers need a secure context. Firebase Hosting is HTTPS, so
       this only ever fires on a plain-http local preview. */
    return;
  }

  const announce = () => {
    if (typeof onUpdateReady === "function") onUpdateReady({ needsUpdate: true });
  };

  navigator.serviceWorker
    .register("sw.js", { scope: "./" })
    .then((registration) => {
      /* A worker left waiting by a visit that closed before it applied. */
      if (registration.waiting && navigator.serviceWorker.controller) {
        waitingWorker = registration.waiting;
        announce();
      }

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state !== "installed") return;
          /* Another worker is in charge, so this one waits. That is the
             normal case: sw.js deliberately never calls skipWaiting on its
             own, and the page decides when to take it. */
          if (navigator.serviceWorker.controller) {
            waitingWorker = installing;
            announce();
          }
          /* With no controller this was the very first install, so there is
             nothing to announce and deliberately no reload — the app is now
             offline-capable, and interrupting whatever the shop was in the
             middle of to say so would be a poor trade. */
        });
      });

      /* A deploy can land while a tab sits open all day. Without this the
         update prompt would not appear until the next navigation. */
      setInterval(() => {
        registration.update().catch(() => {
          /* Offline. The worker already in charge carries on. */
        });
      }, 60 * 60 * 1000);
    })
    .catch((err) => {
      /* A failed registration must never break the page. Offline support is
         the enhancement; the app works perfectly well without it. */
      console.warn("[trustx-pwa] service worker registration failed:", err);
    });
}

/**
 * Add the install and update controls to a topbar.
 *
 * Both start hidden and are revealed only when they have something to say, so
 * a shop already running the installed app never sees a dead control.
 *
 * @param {HTMLElement|null} container  usually `.topbar`
 * @returns {() => void} detaches everything it added
 */
export function mountPwaControls(container) {
  if (!container || typeof document === "undefined") return () => {};

  /* --- Install ------------------------------------------------------ */

  const installBtn = document.createElement("button");
  installBtn.type = "button";
  installBtn.className = "btn btn-ghost btn-sm pwa-control";
  installBtn.hidden = true;
  installBtn.innerHTML = ICON_DOWNLOAD + "<span>Install app</span>";
  installBtn.title = "Install TrustX Ledger as a desktop app";

  const onBeforeInstall = () => {
    /* The prompt was already stored by the module-level listener; this only
       has to reveal the button. No preventDefault() here — doing it twice is
       unnecessary, and the module-level handler owns suppression so the
       browser's own infobar never competes with this button. */
    if (!isInstalled()) installBtn.hidden = false;
  };

  const onInstalled = () => {
    deferredInstallPrompt = null;
    installBtn.hidden = true;
    installBtn.disabled = true;
    document.documentElement.classList.add("is-installed");
  };

  const onInstallClick = async () => {
    const prompt = deferredInstallPrompt;
    if (!prompt) {
      /* The one case where a click genuinely cannot do anything: the browser
         never offered an install prompt, so there is nothing to show. Report
         it instead of silently hiding, because a button that does nothing is
         indistinguishable from a broken one. */
      console.warn(
        "[trustx-pwa] install clicked with no prompt held — the browser never " +
          "fired beforeinstallprompt on this page load. Reload once and try again."
      );
      installBtn.title =
        "This browser has not offered to install the app on this page load. " +
        "Reload and try again.";
      return;
    }
    deferredInstallPrompt = null;
    installBtn.hidden = true;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice && choice.outcome === "accepted") {
        /* appinstalled will hide the button too; this covers the case where
           that event is delayed or never delivered. */
        installBtn.hidden = true;
        return;
      }
      /* Declined. The browser will not offer another prompt on this page, so
         the button has nothing left to do — but it must not vanish without
         explanation, so it is restored and simply stops being useful until
         the next page load. */
      installBtn.hidden = false;
      installBtn.title =
        "Install was dismissed. Open the app again to be offered it once more.";
    } catch (err) {
      /* A genuine failure — most often prompt() called without a user
         gesture, which can happen if the click was synthesised. Restoring the
         button means the next real click can succeed. */
      console.warn("[trustx-pwa] install prompt failed:", err);
      installBtn.hidden = false;
    }
  };

  /* --- Update ------------------------------------------------------- */

  const updateBtn = document.createElement("button");
  updateBtn.type = "button";
  updateBtn.className = "btn btn-ghost btn-sm pwa-control";
  updateBtn.hidden = true;
  updateBtn.innerHTML = ICON_REFRESH + "<span>Update ready</span>";
  updateBtn.title = "A new version of the app is ready. Reload to use it.";

  const onUpdateClick = () => {
    if (!waitingWorker) {
      updateBtn.hidden = true;
      return;
    }
    updateBtn.disabled = true;
    /* Ask the worker to take over, then reload so the page is running the
       new code rather than the old code with a new worker in charge. */
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
    waitingWorker = null;
    window.location.reload();
  };

  const onUpdateReady = () => {
    updateBtn.hidden = false;
  };

  installBtn.addEventListener("click", onInstallClick);
  updateBtn.addEventListener("click", onUpdateClick);
  /* `onBeforeInstall` is also attached at module load, so by the time the
     topbar mounts the prompt may already have been captured and fired. This
     check is what closes that race. */
  window.addEventListener("beforeinstallprompt", onBeforeInstall);
  window.addEventListener("appinstalled", onInstalled);
  container.appendChild(installBtn);
  container.appendChild(updateBtn);

  registerServiceWorker({ onUpdateReady });

  /* Already installed: no install control. The update control is still
     registered for, because an update is exactly what an installed app needs. */
  if (isInstalled()) {
    installBtn.hidden = true;
    installBtn.disabled = true;
    document.documentElement.classList.add("is-installed");
  } else if (deferredInstallPrompt) {
    /* The prompt was captured before this button existed. Show it now. */
    installBtn.hidden = false;
  }

  return () => {
    installBtn.removeEventListener("click", onInstallClick);
    updateBtn.removeEventListener("click", onUpdateClick);
    window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    window.removeEventListener("appinstalled", onInstalled);
    installBtn.remove();
    updateBtn.remove();
  };
}

/* ------------------------------------------------------------------
   THE FIRST-VISIT INSTALL PROMPT
   ------------------------------------------------------------------
   Mounted by admin.html and nowhere else. The Owner console is the one
   screen worth interrupting: it is the screen the shopkeeper comes back
   to, so offering the app there is offering it to the person most likely
   to want it. The daily pages are left alone — a prompt in the middle of
   recording a sale would cost more than it wins.

   IT NEVER NAVIGATES
   The hard rule here is that showing the prompt must not move the user.
   It appears on top of the Owner console and is dismissed from the Owner
   console; not one line below assigns to location or sets an href. An
   install prompt that had to navigate to do its job would make "install
   the app" and "go to the dashboard" the same gesture, and the owner
   would land on the dashboard with no way to tell which one they asked
   for.

   IT DOES NOT WAIT FOR THE BROWSER TO OFFER A PROMPT
   `beforeinstallprompt` is Chromium-only, Chrome fires it late and only
   once it has decided the app qualifies, and iOS Safari never fires it at
   all. Gating the modal on that event would mean the shopkeeper holding
   an iPhone is never offered the app even once — so the modal renders
   regardless, and the button either calls the held prompt or falls back
   to spelling out the two-tap route for that browser.

   IT ASKS ONCE
   Remembered in localStorage rather than a cookie: this is a device-level
   decision about a device-level fact (is the app on this phone's home
   screen), and it must survive a reload without troubling the server.
   ------------------------------------------------------------------ */

/** Where "already been offered" is remembered, per device. */
const ONBOARDING_KEY = "trustx.install-offered.v1";

/**
 * localStorage, or null.
 *
 * The try covers the *read* of the global, not just the write: private-mode
 * Safari throws on touching `localStorage` at all, so a plain
 * `typeof localStorage !== "undefined"` guard still explodes there. This is
 * a nicety; it must never be the thing that takes the console down.
 */
function installStore() {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function alreadyOffered() {
  const store = installStore();
  if (!store) return false;
  try {
    return store.getItem(ONBOARDING_KEY) !== null;
  } catch {
    /* Cannot tell — offer it again. Repeating a prompt is a much smaller
       failure than never showing one. */
    return false;
  }
}

function markOffered() {
  const store = installStore();
  if (!store) return;
  try {
    store.setItem(ONBOARDING_KEY, "1");
  } catch {
    /* Out of quota, or private mode. Next visit asks again. */
  }
}

/**
 * The manual route, for a browser that cannot be asked programmatically.
 *
 * Static strings only — nothing read from the user or the server is put
 * into this HTML, which is why <strong> is safe here.
 */
function manualInstallSteps() {
  const ua = (typeof navigator === "undefined" ? "" : navigator.userAgent) || "";
  const iOS =
    /iPhone|iPad|iPod/i.test(ua) ||
    /* iPadOS reports itself as a Mac; the touch points give it away. */
    (typeof navigator !== "undefined" &&
      navigator.platform === "MacIntel" &&
      navigator.maxTouchPoints > 1);

  if (iOS) {
    return (
      "On this iPhone, tap <strong>Share</strong> in the browser bar, then " +
      "<strong>Add to Home Screen</strong>."
    );
  }
  return (
    "Open the browser menu and choose <strong>Install app</strong> (or " +
    "<strong>Add to Home screen</strong>)."
  );
}

const ICON_DOWNLOAD_LG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/>' +
  '<line x1="12" y1="15" x2="12" y2="3"/></svg>';

/**
 * Offer the app once, on the Owner's first visit.
 *
 * Call this after the console has finished rendering, so the dialog opens
 * over real content rather than over the loading card.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.delay]  ms to wait before opening. One frame's
 *        grace so the dialog animates in on top of a painted screen.
 * @returns {() => void} removes everything it added
 */
export function mountInstallOnboarding({ delay = 250 } = {}) {
  if (typeof document === "undefined" || !document.body) return () => {};

  /* Running as the installed app already: there is nothing to offer, and
     asking would be the single most confusing thing the console could do. */
  if (isInstalled()) {
    document.documentElement.classList.add("is-installed");
    markOffered();
    return () => {};
  }

  /* Answered on this device before. */
  if (alreadyOffered()) return () => {};

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay install-onboarding";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "installOnboardingTitle");
  overlay.innerHTML =
    '<div class="modal modal-sm" role="document">' +
    '<div class="modal-header">' +
    '<div class="modal-header-icon modal-header-icon-install" aria-hidden="true">' +
    ICON_DOWNLOAD_LG +
    "</div>" +
    '<div class="modal-header-text">' +
    '<h3 id="installOnboardingTitle">Keep the ledger on this phone</h3>' +
    '<p class="modal-header-sub">TrustX Ledger &middot; Owner console</p>' +
    "</div>" +
    '<button type="button" class="modal-close" data-close aria-label="Close">' +
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
    "</button>" +
    "</div>" +
    '<div class="modal-body">' +
    "<p>Install it and the Owner console opens like any other app on this " +
    "phone &mdash; no browser bar, and it still opens with the connection " +
    "down.</p>" +
    '<p class="install-onboarding-fallback" data-fallback hidden></p>' +
    "</div>" +
    '<div class="modal-footer">' +
    '<button type="button" class="btn btn-secondary" data-later>Not now</button>' +
    '<button type="button" class="btn btn-primary" data-install>Install app</button>' +
    "</div>" +
    "</div>";
  document.body.appendChild(overlay);

  const installBtn = overlay.querySelector("[data-install]");
  const fallback = overlay.querySelector("[data-fallback]");
  let timer = null;

  /* Any exit at all counts as "asked", so the shopkeeper is never nagged.
     Note this is also what stops it coming back after a deliberate skip. */
  const finish = () => {
    markOffered();
    closeModal(overlay);
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
    setTimeout(() => overlay.remove(), 250);
  };

  const showFallback = () => {
    /* Reached when the button is pressed with nothing held: either an
       iPhone that will never fire the event, or a tap that beat Chrome to
       it. Both are answered by telling the person what to tap instead. */
    fallback.innerHTML = manualInstallSteps();
    fallback.hidden = false;
    installBtn.disabled = true;
    installBtn.textContent = "Use the browser menu";
  };

  const onInstallClick = async () => {
    const prompt = deferredInstallPrompt;
    if (!prompt) {
      showFallback();
      return;
    }
    /* Spent either way — the event does not come back on this page load. */
    deferredInstallPrompt = null;
    installBtn.disabled = true;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice && choice.outcome === "accepted") {
        document.documentElement.classList.add("is-installed");
        finish();
        return;
      }
      /* Declined at the browser's own dialog. Nothing left to try here
         either, so the fallback replaces the now-inert button. */
      showFallback();
    } catch (err) {
      /* Most often prompt() without a user gesture. Leaving the button
         usable means a second, genuine tap can still succeed. */
      console.warn("[trustx-pwa] onboarding install prompt failed:", err);
      installBtn.disabled = false;
    }
  };

  const onLater = () => finish();
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      finish();
    }
  };
  const onBackdrop = (event) => {
    if (event.target === overlay) finish();
  };

  installBtn.addEventListener("click", onInstallClick);
  overlay.querySelector("[data-later]").addEventListener("click", onLater);
  overlay.querySelector("[data-close]").addEventListener("click", onLater);
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("click", onBackdrop);

  /* Installed from some other surface while this sat open. */
  const onInstalledElsewhere = () => finish();
  window.addEventListener("appinstalled", onInstalledElsewhere);

  /* openModal (not a bare classList) because css/style.css keeps
     .modal-overlay at visibility:hidden until is-open — see the same note
     in app.js. It also focuses the first focusable, which here is "Not
     now": the deliberate default is NOT to put a browser install dialog
     one stray Enter away. */
  timer = setTimeout(() => {
    if (!overlay.isConnected) return;
    openModal(overlay);
  }, delay);

  return () => {
    if (timer) clearTimeout(timer);
    installBtn.removeEventListener("click", onInstallClick);
    document.removeEventListener("keydown", onKey, true);
    overlay.removeEventListener("click", onBackdrop);
    window.removeEventListener("appinstalled", onInstalledElsewhere);
    closeModal(overlay);
    overlay.remove();
  };
}

/* Capture the prompt at module load, before any async init.
   `beforeinstallprompt` fires at most once per page load and only after the
   browser has finished its manifest + service-worker checks, which is often
   *before* an app shell that has to wait on Firebase Auth has rendered its
   topbar. Listening inside mountPwaControls alone loses the event outright on
   slow connections and the button stays dead with no way to recover without a
   reload. */
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    document.documentElement.classList.add("can-install");
  });
}