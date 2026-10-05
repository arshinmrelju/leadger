/* =========================================================
   TrustX Ledger — Record a sale (shared modal)
   -----------------------------------------------------------------
   There is exactly ONE sale-entry form and it lives in a modal.
   Every entry point — the dashboard button, the quick-service tiles,
   the history page and Ctrl+N — opens this same dialog instead of
   navigating away, so the shop can record a sale without losing the
   page (and its loaded figures) behind it.

   The modal is built lazily on first open and reused afterwards.
   Pages subscribe with onSaleRecorded() to refresh their own data.
   ========================================================= */

import { toast, setLoading, openModal, closeModal } from "./app.js";
import {
  formatINR,
  paiseToInput,
  sanitizeQuantity,
  rateToPaise,
  computeTotalPaise,
  isPaymentMethod,
  methodLabel,
  todayKolkata,
  isValidDateKey,
  escapeHtml,
  RECEIPT_IMAGE_MAX_BYTES,
  receiptImageBytes,
} from "./utils.js";
import { dayHeading, daysBetweenDateKeys } from "./day-ledger.js";
import {
  fetchServices,
  createService,
  createTransaction,
  fetchDayState,
  flushPendingWrites,
  isNetworkError,
} from "./ledger.js";
import { reportError } from "./auth.js";
import { createServicePicker, serviceTile } from "./service-picker.js";
import { isQuotaExhausted, quotaResetTime } from "./quota.js";

const ICON_PLUS =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

const ICON_CASH =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/></svg>';

const ICON_UPI =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 18h6"/></svg>';

const ICON_CARD =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>';

const ICON_DUE =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';

const ICON_CLOSE =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

const ICON_SALE =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>';

/* ---------------- State ---------------- */

let overlay = null;
let picker = null;
let services = [];
let selectedService = null;
let paymentMethod = "cash";
let saving = false;
let waitingSync = false;
/**
 * The business day this entry will be filed under.
 *
 * The shop writes its ledger in the evening, and it misses days: a sale
 * from Tuesday gets typed up on Thursday, and the whole of one weekend
 * can go unrecorded until the month is checked. So the day is a FIELD on
 * the form rather than an implicit "today", and it defaults to today
 * because that is right almost every time.
 *
 * Module-level (not read from the DOM on save) so the value the summary
 * line describes and the value the write uses cannot disagree, and so
 * opening the form for a specific day — from the calendar, or from a day
 * page — does not depend on an input event having fired.
 */
let targetDateKey = todayKolkata();
/**
 * The scanned receipt to save with this entry, as a JPEG data URL.
 *
 * Module-level for the same reason the business day is: what the thumbnail
 * shows and what the write sends must be the same string, decided once.
 * Cleared on every open, so a scan can never follow the shopkeeper into the
 * next, unrelated sale.
 */
let pendingReceiptImage = null;
/**
 * The name a scanned bill printed, when the shop's catalog does not
 * have it.
 *
 * Held beside the form for the same reason the business day is: the
 * panel that names it, the button that adds it and the rate the new
 * service would be created at are all decided once, from the same
 * reading. Cleared on every open, so a scan cannot follow the
 * shopkeeper into a hand-typed sale.
 */
let scannedName = "";
/** The closest catalog services to offer, when the name is unknown. */
let scannedCandidates = [];
const listeners = new Set();

/** Subscribe to successful saves. Returns an unsubscribe function. */
export function onSaleRecorded(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Tell the pages that a sale landed, from outside this module.
 *
 * The scanner books a multi-line bill as several sales and has no form
 * of its own to emit from (js/image-receipt.js), so it announces
 * through here rather than growing a second refresh path: one
 * `onSaleRecorded` subscription per page, whichever module wrote.
 */
export function emitSaleRecorded(record) {
  emit(record);
}

function emit(record) {
  listeners.forEach((cb) => {
    try {
      cb(record);
    } catch (err) {
      console.error("[trustx-ledger] sale listener:", err);
    }
  });
}

/* ---------------- Markup ---------------- */

function saleFormMarkup() {
  return (
    '<form id="saleForm" novalidate>' +
    '<div class="alert alert-error is-hidden" id="formMsg" role="alert"><span data-form-msg></span></div>' +

    /* What the scanner could not place. Shown ABOVE the form, and only
       when the bill named something the catalog does not have — the
       alternative used to be the form silently refusing the save with
       "Choose a service", which is a dead end for a name the shop has
       never typed before. */
    '<div class="scan-suggest is-hidden" id="scanSuggest" role="group" aria-label="Read from the bill">' +
    '<p class="scan-suggest-head">' +
    '<span class="scan-suggest-label">Read from the bill</span> ' +
    '<strong class="scan-suggest-name" id="scanSuggestName"></strong>' +
    "</p>" +
    '<p class="small muted scan-suggest-note" id="scanSuggestNote"></p>' +
    '<div class="scan-suggest-chips" id="scanSuggestChips"></div>' +
    '<div class="scan-suggest-actions">' +
    '<button type="button" class="btn btn-secondary btn-sm" id="scanSuggestAdd">Add it as a service</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" id="scanSuggestHide">Hide</button>' +
    "</div>" +
    "</div>" +

    /* The business day this entry belongs to. `max` is today: a sale
       cannot be booked into a day the shop has not lived through yet, and
       the native picker refuses the choice before it is made rather than
       after the form is filled in. */
    '<div class="field field-bizday">' +
    '<label for="txnDate">Business day</label>' +
    '<input class="input" id="txnDate" type="date" aria-describedby="bizDayHint" />' +
    '<span class="field-hint" id="bizDayHint" aria-live="polite"></span>' +
    "</div>" +

    '<div class="field">' +
    '<label for="servicePick">Service *</label>' +
    /* The search/grouped listbox is built by js/service-picker.js and
       mounted into this host. */
    '<div id="servicePickHost"></div>' +
    '<div class="flex-between">' +
    '<span class="field-hint">Picks the default rate. You can override it below.</span>' +
    '<button type="button" class="btn btn-ghost btn-sm" id="addServiceToggle">' +
    ICON_PLUS +
    " Add service</button>" +
    "</div></div>" +

    '<div class="field is-hidden" id="addServiceBox">' +
    '<div class="card sale-inline-card">' +
    '<div class="card-body">' +
    '<div class="small muted mb-1 sale-subhead">Add a service</div>' +
    '<div class="form-row">' +
    '<div class="field"><label for="newServiceName">Service name</label>' +
    '<input class="input" id="newServiceName" type="text" maxlength="80" placeholder="e.g. Passport" /></div>' +
    '<div class="field"><label for="newServiceRate">Rate (&#x20B9;)</label>' +
    '<input class="input" id="newServiceRate" type="text" inputmode="decimal" placeholder="e.g. 150" /></div>' +
    "</div>" +
    '<div class="flex" style="justify-content:flex-end;gap:0.5rem;">' +
    '<button type="button" class="btn btn-secondary btn-sm" id="addServiceCancel">Cancel</button>' +
    '<button type="button" class="btn btn-primary btn-sm" id="addServiceSave">Add service</button>' +
    "</div>" +
    "</div></div></div>" +

    '<div class="form-row">' +
    '<div class="field"><label for="qtyInput">Quantity</label>' +
    '<input class="input" id="qtyInput" type="number" inputmode="numeric" min="1" max="100000" step="1" value="1" placeholder="1" /></div>' +
    '<div class="field"><label for="rateInput">Rate (&#x20B9;)</label>' +
    '<input class="input" id="rateInput" type="text" inputmode="decimal" value="" placeholder="0.00" /></div>' +
    "</div>" +

    '<div class="field">' +
    "<label>Payment method</label>" +
    '<div class="seg-row" id="methodRow" role="group" aria-label="Payment method">' +
    '<button type="button" class="seg-btn seg-cash is-active" data-method="cash">' + ICON_CASH + 'Cash</button>' +
    '<button type="button" class="seg-btn seg-upi" data-method="upi">' + ICON_UPI + 'UPI</button>' +
    '<button type="button" class="seg-btn seg-card" data-method="card">' + ICON_CARD + 'Card</button>' +
    '<button type="button" class="seg-btn seg-due" data-method="due">' + ICON_DUE + 'Due</button>' +
    "</div>" +
    '<span class="field-hint" id="methodHint">Recorded as paid.</span>' +
    "</div>" +

    '<div class="field"><label for="customerInput">Customer <span class="small muted">(optional)</span></label>' +
    '<input class="input" id="customerInput" type="text" maxlength="120" autocomplete="off" placeholder="Customer name" /></div>' +

    /* The scanned receipt, shown as a thumbnail the shopkeeper can see is
       attached and can take back before saving. Hidden unless the scanner
       handed one over, so a hand-typed sale carries no empty box. */
    '<div class="field-receipt is-hidden" id="receiptAttach">' +
    '<span class="field-receipt-label">Receipt photo</span>' +
    '<div class="receipt-chip">' +
    '<img class="receipt-chip-thumb" id="receiptThumb" alt="Scanned receipt" />' +
    '<span class="receipt-chip-meta" id="receiptMeta"></span>' +
    '<button type="button" class="receipt-chip-remove" id="receiptRemove" ' +
    'aria-label="Do not attach this receipt photo">Remove</button>' +
    "</div></div>" +

    '<div class="entry-total" aria-live="polite">' +
    '<span class="entry-total-label">Total</span>' +
    '<span class="entry-total-value" id="totalPreview">' +
    formatINR(0) +
    "</span>" +
    "</div>" +

    '<button type="submit" class="btn-save-txn btn-receipt-pay" id="saveBtn">' +
    ICON_PLUS +
    '<span>SAVE TRANSACTION</span>' +
    "</button>" +
    "</form>"
  );
}

function buildOverlay() {
  const el = document.createElement("div");
  el.className = "modal-overlay";
  el.id = "saleModal";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "saleModalTitle");
  el.innerHTML =
    '<div class="modal modal-lg" role="document">' +
    '<div class="modal-header">' +
    '<div class="modal-header-icon modal-header-icon-sale" aria-hidden="true">' +
    ICON_SALE +
    '</div>' +
    '<div class="modal-header-text">' +
    '<h3 id="saleModalTitle">Record a sale</h3>' +
    '<p class="modal-header-sub">Quick entry for shop services &amp; customer billing</p>' +
    '</div>' +
    '<button type="button" class="modal-close" data-close aria-label="Close">' +
    ICON_CLOSE +
    '</button>' +
    "</div>" +
    '<div class="modal-body">' +
    saleFormMarkup() +
    '<div class="sale-quick">' +
    '<div class="small muted mb-1 sale-subhead">Quick services</div>' +
    '<div class="quick-grid" id="saleQuickGrid"></div>' +
    '<p class="small muted mt-1" id="saleQuickHint" style="margin-bottom:0;">Tap a service to fill the form.</p>' +
    "</div>" +
    "</div></div>";
  document.body.appendChild(el);
  picker = createServicePicker(el.querySelector("#servicePickHost"), {
    inputId: "servicePick",
    onSelect: (service) => {
      selectedService = service;
      /* `el`, not the module-level overlay: the module is only assigned
         after this factory returns. */
      el.querySelector("#rateInput").value = service ? paiseToInput(service.pricePaise) : "";
      hideFormMsg();
      /* The question the scan asked is answered the moment a service is
         chosen — by tapping a chip, by typing, by a quick tile, by all
         three. And if the choice is taken back, it is a question again. */
      if (service) hideScanSuggest();
      else if (scannedName) showScanSuggest(scannedName, scannedCandidates);
      updateTotal();
    },
    /* "No match in your catalog" offers to add what was typed — the
       search box is then the fastest way to invent a new service. */
    onCreate: (query) => openAddServiceBox(query || scannedName),
  });
  wire(el);
  return el;
}

/* ---------------- The name the scan could not place ---------------- */

/**
 * Name a service the bill printed and the catalog does not have, with
 * the closest ones to choose from.
 *
 * This is the second half of the scan's job. Reading "Laminate A4" and
 * having nowhere to put it used to end in a form that refused to save
 * until the shop typed something sensible — so the honest reading was
 * thrown away and the bill had to be re-entered by hand. Here the name
 * is shown as it was read, the near misses are one tap away, and adding
 * the service is offered for the case where the bill is right and the
 * catalog is behind.
 */
function showScanSuggest(name, candidates) {
  if (!overlay) return;
  const box = overlay.querySelector("#scanSuggest");
  if (!box) return;
  const text = String(name || "").trim();
  if (!text) return;
  scannedName = text;
  scannedCandidates = Array.isArray(candidates) ? candidates : [];

  const nameEl = overlay.querySelector("#scanSuggestName");
  if (nameEl) nameEl.textContent = "“" + text + "”";
  const note = overlay.querySelector("#scanSuggestNote");
  if (note) {
    note.textContent = scannedCandidates.length
      ? "That name is not in your catalog. Pick the service it belongs to, or add the name as a new one."
      : "That name is not in your catalog. Add it as a service, or pick one below.";
  }
  const chips = overlay.querySelector("#scanSuggestChips");
  if (chips) {
    chips.innerHTML = "";
    for (const service of scannedCandidates) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "btn btn-secondary btn-sm";
      chip.textContent = service.name + " · " + formatINR(service.pricePaise);
      chip.addEventListener("click", () => applySuggestedService(service.serviceId));
      chips.appendChild(chip);
    }
  }
  box.classList.remove("is-hidden");
}

function hideScanSuggest() {
  const box = overlay && overlay.querySelector("#scanSuggest");
  if (box) box.classList.add("is-hidden");
}

/**
 * Take one of the near misses, keeping the rate the BILL said.
 *
 * The picker's own onSelect writes the catalog's default rate, which is
 * right for a service tapped out of the list and wrong here: the price
 * on the paper is the price that was charged, and a suggestion chip is
 * only naming the service, never repricing the sale.
 */
function applySuggestedService(serviceId) {
  if (!overlay || !picker) return;
  const rateField = overlay.querySelector("#rateInput");
  const scannedRate = rateField ? rateField.value : "";
  picker.setValue(serviceId);
  if (rateField && scannedRate) {
    rateField.value = scannedRate;
    rateField.dispatchEvent(new Event("input", { bubbles: true }));
  }
  hideScanSuggest();
  updateTotal();
}

/* ---------------- Open / close ---------------- */

/**
 * Open the record-a-sale dialog.
 * @param {object} [opts]
 * @param {string} [opts.serviceId] preselect a service (e.g. from a quick tile)
 * @param {string} [opts.dateKey]  business day to file the entry under;
 *   defaults to today. The calendar passes the day whose cell was tapped,
 *   so catching up a missed day never means re-picking the date by hand.
 */
export function openSaleForm({ serviceId = "", dateKey = "" } = {}) {
  if (!overlay) overlay = buildOverlay();

  hideFormMsg();
  closeAddServiceBox();
  /* Set before resetForm(): the day belongs to the open, not to the last
     entry, so closing the dialog without saving cannot leak the previous
     day's date into the next sale. */
  setTargetDate(dateKey);
  /* Likewise the photo: a scan belongs to the sale it was scanned for, and
     must not follow the shopkeeper into the next entry. */
  setReceiptImage(null);
  /* And likewise the name the last bill could not place: a hand-typed
     sale has no bill, so it must not be shown one. */
  scannedName = "";
  scannedCandidates = [];
  hideScanSuggest();
  resetForm();
  openModal(overlay);
  renderQuickGrid();

  /* Services are cheap to re-read (Firestore serves from cache) and the
     catalog may have changed since the last sale, so refresh every open. */
  refreshServices()
    .then(() => {
      if (serviceId) pickService(serviceId);
    })
    .catch(() => { });
}

/* ---------------- The receipt photo ---------------- */

/**
 * Attach (or detach) the scanned receipt for this entry.
 *
 * Held in module state rather than read back off the thumbnail, because the
 * data URL is what gets written and the element is only a picture of it. A
 * photo that is too big is refused HERE, with the size in the sentence,
 * rather than arriving at the rules as a bare denial after the form is
 * filled in.
 */
function setReceiptImage(dataUrl) {
  const box = overlay && overlay.querySelector("#receiptAttach");
  const img = overlay && overlay.querySelector("#receiptThumb");
  const meta = overlay && overlay.querySelector("#receiptMeta");

  const image = String(dataUrl || "").trim();
  if (!image) {
    pendingReceiptImage = null;
    if (box) box.classList.add("is-hidden");
    if (img) img.removeAttribute("src");
    if (meta) meta.textContent = "";
    return true;
  }

  const bytes = receiptImageBytes(image);
  if (bytes === null) {
    showFormMsg("That receipt photo could not be read, so it was not attached.");
    return false;
  }
  if (bytes > RECEIPT_IMAGE_MAX_BYTES) {
    showFormMsg(
      "That receipt photo is " + Math.round(bytes / 1024) + " KB, over the " +
      Math.round(RECEIPT_IMAGE_MAX_BYTES / 1024) + " KB the ledger keeps. " +
      "Re-scan it closer to the bill, or save the sale without it."
    );
    return false;
  }

  pendingReceiptImage = image;
  if (img) img.src = image;
  if (meta) meta.textContent = Math.round(bytes / 1024) + " KB, saved with this sale";
  if (box) box.classList.remove("is-hidden");
  hideFormMsg();
  return true;
}

/* ---------------- The business day ---------------- */

/**
 * Point the form at a business day.
 *
 * Anything that is not a real, already-lived day falls back to today: a
 * stale link or a bad value must not park an entry on a day that does not
 * exist, and `onSave` re-checks the same way before it writes.
 */
function setTargetDate(dateKey) {
  const today = todayKolkata();
  const wanted = String(dateKey || "").trim();
  const valid = wanted && isValidDateKey(wanted) && wanted <= today;
  targetDateKey = valid ? wanted : today;
  syncDateField();
}

/** Push the current business day into the input and its summary line. */
function syncDateField() {
  if (!overlay) return;
  const input = overlay.querySelector("#txnDate");
  if (input) {
    /* `max` follows today: the app can be left open across the Kolkata
       rollover, and a form opened at 11pm must not still allow tomorrow. */
    input.max = todayKolkata();
    if (input.value !== targetDateKey) input.value = targetDateKey;
  }
  const hint = overlay.querySelector("#bizDayHint");
  if (hint) hint.textContent = businessDayHint(targetDateKey);
  /* The field itself says so too. An amber panel is the one thing on the
     form that survives a glance, and "which day?" is the question this
     whole field exists to force. */
  const field = overlay.querySelector(".field-bizday");
  if (field) field.classList.toggle("is-backfill", isBackfillDate(targetDateKey));
}

/** True when the entry is being filed against a day that has already passed. */
function isBackfillDate(dateKey) {
  return isValidDateKey(dateKey) && dateKey < todayKolkata();
}

/**
 * Say plainly which day this entry will land on.
 *
 * The dangerous mistake in an evening-entry ledger is filing a sale
 * against the wrong day without noticing, so a backfill is named as one:
 * which day, and how long ago. A day that has not happened yet is called
 * out too — the native `max` stops the picker choosing one, but a value
 * can still arrive from a link.
 */
function businessDayHint(dateKey) {
  if (!isValidDateKey(dateKey)) return "Pick the business day this sale belongs to.";
  const today = todayKolkata();
  if (dateKey === today) return "Tonight's takings — " + dayHeading(today) + ".";
  if (dateKey > today) return "That day has not happened yet. A sale cannot be booked into it.";

  const back = daysBetweenDateKeys(dateKey, today);
  const ago = back === 1 ? "yesterday" : back + " days ago";
  return "Adding to " + dayHeading(dateKey) + " — " + ago + ".";
}

/** Ctrl+N anywhere in the app opens the same dialog. */
window.addEventListener("seva:new-txn", () => openSaleForm());

/* ---------------- Wiring ---------------- */

function wire(root) {
  const addBox = root.querySelector("#addServiceBox");

  root.querySelector("#addServiceToggle").addEventListener("click", () => {
    if (addBox.classList.contains("is-hidden")) openAddServiceBox();
    else closeAddServiceBox();
  });
  root.querySelector("#addServiceCancel").addEventListener("click", closeAddServiceBox);
  root.querySelector("#addServiceSave").addEventListener("click", saveNewService);

  root.querySelector("#qtyInput").addEventListener("input", updateTotal);
  root.querySelector("#rateInput").addEventListener("input", updateTotal);

  /* Changing the business day moves this entry to another day, which is
     exactly the thing the summary line exists to make visible, so the
     hint refreshes on every change rather than on save. */
  root.querySelector("#txnDate").addEventListener("change", (event) => {
    setTargetDate(event.target.value);
  });

  root.querySelector("#receiptRemove").addEventListener("click", () => setReceiptImage(null));

  /* The scan's "this name is not in your catalog" panel. Add opens the
     add-service box with the name the bill printed already in it, and
     Hide just takes the panel away — neither one touches the rest of
     the entry. */
  const suggestAdd = root.querySelector("#scanSuggestAdd");
  if (suggestAdd) suggestAdd.addEventListener("click", () => openAddServiceBox(scannedName));
  const suggestHide = root.querySelector("#scanSuggestHide");
  if (suggestHide) suggestHide.addEventListener("click", () => hideScanSuggest());

  root.querySelectorAll("#methodRow .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      paymentMethod = btn.dataset.method;
      root.querySelectorAll("#methodRow .seg-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      updateTotal();
    });
  });

  root.querySelector("#saleForm").addEventListener("submit", onSave);

  /* Enter inside the add-service box should add the service, not submit
     the (still incomplete) sale form. */
  root.querySelector("#addServiceBox").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveNewService();
    }
  });
}

function closeAddServiceBox() {
  const box = overlay && overlay.querySelector("#addServiceBox");
  if (box) box.classList.add("is-hidden");
}

/** Open the add-service box, optionally pre-filled from a picker search. */
function openAddServiceBox(prefill = "") {
  const box = overlay && overlay.querySelector("#addServiceBox");
  if (!box) return;
  const nameInput = overlay.querySelector("#newServiceName");
  box.classList.remove("is-hidden");
  if (prefill) nameInput.value = String(prefill).slice(0, 80);
  /* The rate field is the part a human must fill in, so start there. */
  setTimeout(() => overlay.querySelector("#newServiceRate").focus(), 40);
}

function showFormMsg(message) {
  const box = overlay && overlay.querySelector("#formMsg");
  if (!box) return;
  box.classList.remove("is-hidden");
  box.querySelector("[data-form-msg]").textContent = message;
}

function hideFormMsg() {
  const box = overlay && overlay.querySelector("#formMsg");
  if (box) box.classList.add("is-hidden");
}

/* ---------------- Services ---------------- */

async function refreshServices() {
  try {
    services = await fetchServices();
  } catch (err) {
    console.warn("[trustx-ledger] services:", err);
    services = [];
  }
  if (!overlay) return;
  picker.setServices(services);
  renderQuickGrid();
}

/* The tile logic now lives with the picker, so a service looks the same
   in the search list and on the quick tiles. */
function quickCode(s) {
  return serviceTile(s);
}

function renderQuickGrid() {
  const grid = overlay && overlay.querySelector("#saleQuickGrid");
  const hint = overlay && overlay.querySelector("#saleQuickHint");
  if (!grid) return;

  const shown = services.slice(0, 16);

  grid.innerHTML =
    shown
      .map(
        (s) =>
          '<button type="button" class="quick-service" tabindex="-1" data-id="' +
          escapeHtml(s.serviceId) +
          '">' +
          '<span class="qs-icon">' +
          escapeHtml(quickCode(s)) +
          "</span>" +
          '<span class="qs-name">' +
          escapeHtml(s.name) +
          "</span>" +
          '<span class="qs-price">' +
          (s.pricePaise >= 0 ? formatINR(s.pricePaise) : "&nbsp;") +
          "</span>" +
          "</button>"
      )
      .join("") ||
    '<div class="state" style="padding:0.75rem 0;"><p class="muted" style="margin:0;">No services yet \u2014 use \u201CAdd service\u201D above to create your first one.</p></div>';

  grid.querySelectorAll(".quick-service").forEach((btn) => {
    btn.addEventListener("click", () => pickService(btn.dataset.id));
  });

  if (hint) {
    if (!services.length) {
      hint.textContent = "No services yet \u2014 use \u201CAdd service\u201D above to create your first one.";
      return;
    }
    /* The grid is capped for the modal's height; the select above always
       holds the whole catalog, so point there when the tail is hidden. */
    const extra = services.length - shown.length;
    hint.textContent = extra > 0
      ? "Tap a service to fill the form. " + extra + " more in the dropdown above."
      : "Tap a service to fill the form.";
  }
}

function pickService(id) {
  if (!overlay || !picker) return;
  if (!services.some((s) => s.serviceId === id)) return;
  /* The picker's onSelect owns the rate and the total, so a quick tile
     behaves exactly like typing the name in the search box. */
  picker.setValue(id);
  overlay.querySelector("#qtyInput").value = "1";
  hideFormMsg();
  updateTotal();
  overlay.querySelector("#qtyInput").focus();
}

async function saveNewService() {
  const name = overlay.querySelector("#newServiceName").value.trim();
  const rate = overlay.querySelector("#newServiceRate").value;
  const btn = overlay.querySelector("#addServiceSave");
  if (!name) {
    toast("Enter a service name.", "error");
    return;
  }
  if (rateToPaise(rate) === null) {
    toast("Enter a valid rate.", "error");
    return;
  }
  setLoading(btn, true);
  try {
    const created = await createService({ name, price: rate });
    await refreshServices();
    closeAddServiceBox();
    pickService(created.serviceId);
    toast('Service "' + created.name + '" added.', "success");
  } catch (err) {
    toast(reportError(err), "error");
  } finally {
    setLoading(btn, false);
  }
}

/* ---------------- Live total ---------------- */

function updateTotal() {
  if (!overlay) return;
  const qty = sanitizeQuantity(overlay.querySelector("#qtyInput").value);
  const ratePaise = rateToPaise(overlay.querySelector("#rateInput").value);
  const total = computeTotalPaise(qty, ratePaise);
  const preview = overlay.querySelector("#totalPreview");
  const hint = overlay.querySelector("#methodHint");

  if (total === null || qty === null || ratePaise === null) {
    preview.textContent = formatINR(0);
    if (hint) hint.textContent = "Enter a valid quantity and rate.";
    return;
  }
  preview.textContent = formatINR(total);
  if (hint) {
    hint.textContent =
      paymentMethod === "due"
        ? "Recorded as pending \u2014 it will count as due until paid."
        : "Recorded as paid (" + methodLabel(paymentMethod) + ").";
  }
}

/* ---------------- Save ---------------- */

/**
 * A sale that hit the free-plan wall, shown as a dialog the shop cannot
 * dismiss by accident.
 *
 * This is the one place in the app where a wrong-looking screen costs
 * actual money. Offline persistence holds a write while the connection is
 * down, but it does NOT hold a write the server refused — and a spent daily
 * quota refuses everything. So the sale the shopkeeper just typed is gone,
 * the form is deliberately left filled in, and the numbers are put on the
 * clipboard so nothing has to be remembered or retyped from a phone screen.
 *
 * The dialog has no close button and no backdrop-dismiss on purpose: the
 * only way out is the explicit "I have written it down" button, so the
 * acknowledgement is a decision rather than a reflex.
 */
function showQuotaSalvageModal({ totalPaise, serviceName, quantity, ratePaise, customerName, method }) {
  const resetAt = quotaResetTime();
  const when = resetAt ? `around ${resetAt} today` : "shortly";
  const summary = [
    `${formatINR(totalPaise)}`,
    serviceName,
    `x ${quantity}`,
    `@ ${formatINR(ratePaise)}`,
    methodLabel(method),
    customerName ? `for ${customerName}` : "",
  ]
    .filter(Boolean)
    .join("  ·  ");

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay is-open";
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <div class="modal" role="document">
      <div class="modal-header">
        <h3>This sale was not saved</h3>
      </div>
      <div class="modal-body">
        <p><strong>Today's free Firebase limit has been reached.</strong> The shop
        cannot write anything until it resets ${escapeHtml(when)}.</p>
        <p>Your entry is still in the form behind this dialog, and it has been
        copied to the clipboard. Write this sale down now:</p>
        <p class="quota-salvage-line">${escapeHtml(summary)}</p>
        <p class="muted">Closing this dialog will NOT save it. Re-enter the sale
        after the reset.</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-primary" data-ack>I have written it down</button>
      </div>
    </div>`;

  /* Belt and braces: the overlay is created already open, so append it
     directly rather than through openModal() and accept its focus
     handling. Nothing closes it but the button. */
  document.body.appendChild(overlay);

  /* app.js has one document-level handler that closes ANY .modal-overlay
     when the click landed on the backdrop itself. Left alone, a stray click
     beside this dialog would dismiss it — and dismissing it is precisely
     what loses the sale, because it looks like the message was dealt with.
     Stopping propagation here means the acknowledgement really does take a
     deliberate click on the button. */
  overlay.addEventListener("click", (event) => event.stopPropagation());

  const done = () => {
    if (!overlay.isConnected) return;
    overlay.classList.remove("is-open");
    setTimeout(() => overlay.remove(), 190);
  };

  const ack = overlay.querySelector("[data-ack]");
  if (ack) ack.addEventListener("click", done);
  setTimeout(() => ack && ack.focus(), 60);

  /* Best effort, and deliberately not awaited — a clipboard refusal must
     not stop the dialog from appearing. The summary is on screen either
     way, which is the part that matters. */
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(summary).catch(() => {});
    }
  } catch {
    /* Clipboard unavailable (insecure context, permissions). */
  }

  return done;
}

async function onSave(event) {
  event.preventDefault();
  if (saving) return; // double-submit guard
  hideFormMsg();

const qty = sanitizeQuantity(overlay.querySelector("#qtyInput").value);
  const ratePaise = rateToPaise(overlay.querySelector("#rateInput").value);
  const total = computeTotalPaise(qty, ratePaise);
  const customer = overlay.querySelector("#customerInput").value.trim();

  if (!selectedService) return showFormMsg("Choose a service for this sale.");
  if (qty === null) return showFormMsg("Quantity must be a whole number greater than 0.");
  if (ratePaise === null) return showFormMsg("Enter a valid rate (\u20B90 or more, up to \u20B91,00,000).");
  if (total === null) return showFormMsg("The total is out of the allowed range.");
  if (!isPaymentMethod(paymentMethod)) return showFormMsg("Choose a payment method.");

  /* The day is re-read from module state rather than from the input, so
     the day that was described to the shop is provably the day that is
     written — and a day that has not happened yet is refused here with a
     sentence, instead of arriving at the rules as a denial. */
  const today = todayKolkata();
  if (!isValidDateKey(targetDateKey)) {
    return showFormMsg("Pick the business day this sale belongs to.");
  }
  if (targetDateKey > today) {
    return showFormMsg("That day has not happened yet, so a sale cannot be booked into it.");
  }
  const isBackfill = targetDateKey !== today;

  saving = true;
  const btn = overlay.querySelector("#saveBtn");
  setLoading(btn, true);
  try {
    const dateKey = targetDateKey;

    /* The rules refuse a sale against a closed day (dayOpen in
       firestore.rules), and they answer only "denied" — never which
       clause failed. So the day is re-read here, immediately before the
       write, rather than trusting whatever the page showed when this
       dialog opened: another device on the counter can close the day
       while the form is open. Without this the shop fills in a whole
       sale and is told the rules are out of date, which is both wrong
       and unactionable.

predictable refusal into a sentence the shop can act on. */
    const day = await fetchDayState(dateKey);
    if (day.closed) {
      showFormMsg(
        "The business day " + dayHeading(dateKey) + " is closed, so a sale cannot be added to it. " +
        "Reopen that day from the Daily Ledger page, or record this sale against an open day."
      );
      return;
    }

    const result = await createTransaction({
      serviceId: selectedService.serviceId,
      serviceName: selectedService.name,
      quantity: qty,
      rate: ratePaise / 100, // paise -> rupees input for createTransaction
      paymentMethod,
      customerName: customer,
      dateKey,
      receiptImage: pendingReceiptImage,
    });

    /* Close the modal immediately on success */
    closeModal(overlay);

    /* Celebration: the cha-ching, the coin shower, and the splash
       screen with the animated tick. */
    const online = navigator.onLine;
    celebrateSavedSale({
      totalPaise: result.totalPaise,
      serviceName: selectedService ? selectedService.name : "",
      quantity: qty,
      ratePaise,
      customerName: customer,
      method: paymentMethod,
    });

    /* The splash is the confirmation while online, so it says
       everything the toast did. Offline still needs the toast: the
       shop has to know this one is queued, not stored. */
    if (!online) {
      toast("Saved offline \u2014 " + formatINR(result.totalPaise) + ". Will sync automatically.", "success", 5200);
      if (!waitingSync) scheduleSyncConfirmation();
    }

    /* A backfill is confirmed by naming the day it landed on. Without
       this, a sale typed up on Thursday for Tuesday closes the dialog
       with no visible sign that anything other than tonight was
       touched — and the whole point of the day field is that the shop
       can see which day they are writing up. */
    if (isBackfill) {
      toast("Added to " + dayHeading(dateKey) + " \u2014 " + formatINR(result.totalPaise) + ".", "success", 5200);
    }

    emit(result);
    resetForm();
  } catch (err) {
    console.error("[trustx-ledger] save:", err);

    /* The free-plan wall, handled before anything else can soften it. The
       form is NOT reset and the modal is NOT closed: the entry is still
       there and still correct, and the shop is told to write it down. */
    if (isQuotaExhausted(err)) {
      showQuotaSalvageModal({
        totalPaise: total,
        serviceName: selectedService ? selectedService.name : "",
        quantity: qty,
        ratePaise,
        customerName: customer,
        method: paymentMethod,
      });
      return;
    }

    showFormMsg(
      isNetworkError(err)
        ? "Could not save right now. Check your connection and try again."
        : reportError(err, { action: "sale" })
    );
  } finally {
    saving = false;
    setLoading(btn, false);
  }
}

/** Clear the entry fields, keeping the chosen service and method. */
function resetForm() {
  if (!overlay) return;
  /* The picker's own state is left alone: it and `selectedService` are only
     ever changed together through onSelect, and the services have not been
     re-read yet at this point.

  The business day is reset too, but to the day this form was opened for
     rather than to today: saving several sales against one missed
     evening should not walk the day forward onto tonight after the
     first one. */
  overlay.querySelector("#qtyInput").value = "1";
  overlay.querySelector("#rateInput").value = selectedService ? paiseToInput(selectedService.pricePaise) : "";
  overlay.querySelector("#customerInput").value = "";
  /* The name the last bill could not place belongs to that bill: once
     this form has been reset the next sale has no reading behind it, and
     a suggestion panel for a service nobody is booking is noise. */
  scannedName = "";
  scannedCandidates = [];
  hideScanSuggest();
  syncDateField();
  updateTotal();
}

function scheduleSyncConfirmation() {
  waitingSync = true;
  window.addEventListener(
    "online",
    async () => {
      try {
        await flushPendingWrites();
        toast("Changes synced.", "success");
        emit({ synced: true });
      } catch (_) {
        /* still offline; try again next time */
      } finally {
        waitingSync = false;
      }
    },
    { once: true }
  );
}

/* ---------------- Coin celebration ---------------- */

/* The coins are files, not CSS gradients: a reeded rim and an embossed
   rupee cannot be drawn with a radial-gradient, and a hand-drawn one
   reads as a gold dot. Loaded through <img>, so each copy is an
   isolated document and the gradient ids inside cannot collide. */
const COIN_ASSETS = [
  new URL("../assets/coin-gold.svg", import.meta.url).href,
  new URL("../assets/coin-silver.svg", import.meta.url).href,
];

/* Warm the cache so the first sale's bar does not show bare lanes while
   the SVGs are still in flight. */
for (const src of COIN_ASSETS) {
  const img = new Image();
  img.src = src;
}

const CHA_CHING_URL = new URL("../assets/cha-ching.mp3", import.meta.url).href;
let chaChing = null;
try {
  chaChing = new Audio(CHA_CHING_URL);
  chaChing.preload = "auto";
  chaChing.load();
} catch (_) { }

/**
 * Play the classic Cash Register "Cha-Ching!" sound.
 *
 * The element is built once and reused: a fresh `new Audio()` per sale
 * throws away the buffered decode and makes the shop wait on the network
 * for a sound that is supposed to be instant.
 */
function playCoinSound() {
  try {
    const audio = chaChing || new Audio(CHA_CHING_URL);
    audio.currentTime = 0;
    const playPromise = audio.play();
    if (playPromise !== undefined) {
      playPromise.catch((err) => {
        console.warn("[trustx-ledger] cha-ching play failed:", err);
      });
    }
  } catch (err) {
    console.warn("[trustx-ledger] audio error:", err);
  }
}


/**
 * A short burst of coins from the centre of the page, flipping as they
 * arc up and rain down.
 *
 * Kept deliberately light: 38 coins for 2.4s buried the page the shop
 * was trying to read, and this plays over the confirmation bar on every
 * single sale. It is `pointer-events: none` (css/style.css), so it never
 * blocks anything - the job here is to not be annoying.
 */
function showCoinBurst() {
  const wrap = document.createElement("div");
  wrap.className = "coin-burst-overlay";
  wrap.setAttribute("aria-hidden", "true");
  document.body.appendChild(wrap);

  const COIN_COUNT = 18;

  for (let i = 0; i < COIN_COUNT; i++) {
    const coin = document.createElement("div");
    coin.className = "jackpot-coin";

    /* Launch point around center */
    const startX = 50 + (Math.random() - 0.5) * 16;
    const startY = 48 + (Math.random() - 0.5) * 8;

    /* Horizontal spread: spills across the screen */
    const screenW = Math.min(window.innerWidth || 1000, 1200);
    const vx = (Math.random() - 0.5) * screenW * 0.85;

    /* Upward fountain burst: shoots up before arcing down */
    const vyUp = -(180 + Math.random() * 260);

    /* Falling down past the viewport bottom */
    const vyDown = 360 + Math.random() * 460;

    /* Varied depth and coin sizes (18px to 32px) */
    const size = Math.round(18 + Math.random() * 14);

    /* Staggered eruption delay (0 to 320ms) for continuous spill */
    const delay = Math.round(Math.random() * 320);
    const duration = (1 + Math.random() * 0.35).toFixed(2);

    /* 3D spin properties */
    const spinX = Math.round((Math.random() - 0.5) * 360);
    const spinY = Math.round((Math.random() < 0.5 ? 1 : -1) * (720 + Math.random() * 720));
    const spinZ = Math.round((Math.random() - 0.5) * 180);

    Object.assign(coin.style, {
      left: startX + "%",
      top: startY + "%",
      width: size + "px",
      height: size + "px",
      animationDelay: delay + "ms",
      animationDuration: duration + "s",
      "--vx": vx + "px",
      "--vy-up": vyUp + "px",
      "--vy-down": vyDown + "px",
      "--spin-x": spinX + "deg",
      "--spin-y": spinY + "deg",
      "--spin-z": spinZ + "deg",
    });

    const face = document.createElement("img");
    face.className = "jackpot-coin-face";
    face.alt = "";
    face.decoding = "async";
    face.src = COIN_ASSETS[i % COIN_ASSETS.length];
    coin.appendChild(face);
    wrap.appendChild(coin);
  }

  /* Remove overlay after the longest coin has finished falling */
  setTimeout(() => wrap.remove(), 1700);
}

/* ---------------- Success splash ---------------- */

/* A confirmation, not a cutscene: long enough to read the tick draw and
   the total land, short enough that the counter is not waiting on a
   decoration before it can carry on. */
const SPLASH_LIFETIME_MS = 2800;

let splashEl = null;
let splashTimer = 0;

const ICON_TICK_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

/* The tick is drawn in three passes - the disc, then the amber ring
   sweeping in behind it, then the check - so the stamp builds itself
   rather than appearing. */
const SPLASH_TICK =
  '<div class="success-splash-tick">' +
  '<svg viewBox="0 0 96 96" focusable="false" aria-hidden="true">' +
  '<circle class="splash-tick-disc" cx="48" cy="48" r="42" />' +
  '<circle class="splash-tick-ring" cx="48" cy="48" r="46" />' +
  '<path class="splash-tick-mark" d="M32 49 L42.5 60.5 L65 37" />' +
  "</svg></div>";

/**
 * Docked success confirmation: an animated tick, the total counting up,
 * and the sale's own details, in a bar that slides down from the top of
 * the viewport and takes itself away again.
 *
 * It deliberately does NOT cover the page and does NOT take focus. The
 * save has just made the page start reloading its figures, and a modal
 * over the top means the shop watches a coin shower instead of its own
 * numbers landing. So the whole overlay is `pointer-events: none` and
 * only the dismiss button is clickable, and it announces itself as a
 * polite status rather than a dialog.
 *
 * Re-showing it (a second sale saved while the first is still up)
 * replaces the old one rather than stacking two.
 */
function showSuccessSplash({
  totalPaise,
  serviceName,
  quantity,
  ratePaise,
  customerName,
  method,
  online,
}) {
  dismissSplash(true);

  const total = Number.isFinite(totalPaise) ? totalPaise : 0;

  /* One line of context: what was sold, for whom, how it was paid. */
  const bits = [];
  if (serviceName) {
    const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : null;
    const rate = Number.isFinite(ratePaise) ? " @ " + formatINR(ratePaise) : "";
    bits.push(
      escapeHtml(serviceName) + (qty ? " × " + qty + escapeHtml(rate) : "")
    );
  }
  if (customerName) bits.push("for " + escapeHtml(customerName));
  if (isPaymentMethod(method)) {
    bits.push(method === "due" ? "pending payment" : "paid by " + methodLabel(method));
  }

  const scrim = document.createElement("div");
  scrim.className = "success-splash";

  scrim.innerHTML =
    '<div class="success-splash-bar" role="status">' +
    '<div class="success-splash-coins" aria-hidden="true"></div>' +
    SPLASH_TICK +
    '<div class="splash-copy">' +
    /* Offline is a change of wording, not an extra badge: the bar is
       already one line of text, and the sync toast says the rest. */
    '<p class="splash-title">' +
    (online ? "Transaction saved" : "Saved offline \u2014 will sync") +
    "</p>" +
    (bits.length ? '<p class="splash-sub">' + bits.join(" &middot; ") + "</p>" : "") +
    "</div>" +
    '<p class="splash-amount" data-splash-amount></p>' +
    '<button type="button" class="splash-close" data-splash-dismiss aria-label="Dismiss confirmation">' +
    ICON_TICK_CLOSE +
    "</button>" +
    "</div>";

  document.body.appendChild(scrim);
  splashEl = scrim;

  const bar = scrim.querySelector(".success-splash-bar");
  fillSlidingCoins(bar);
  countUpAmount(scrim.querySelector("[data-splash-amount]"), total);

  const close = scrim.querySelector("[data-splash-dismiss]");
  if (close) close.addEventListener("click", () => dismissSplash());

  /* No Escape handler and no focus() here on purpose: this is a status,
     not a dialog. Stealing the keyboard would fight whatever the shop
     is doing on the page underneath, and Escape has a job there. */
  splashTimer = setTimeout(() => dismissSplash(), SPLASH_LIFETIME_MS);
}

/** Fade the bar back up and detach it. `immediate` skips the animation. */
function dismissSplash(immediate = false) {
  if (!splashEl) return;
  const el = splashEl;
  splashEl = null;

  clearTimeout(splashTimer);

  if (immediate) {
    el.remove();
    return;
  }
  el.classList.add("is-closing");
  setTimeout(() => el.remove(), 260);
}

/**
 * Scatter coins sliding across the bar as low-opacity texture.
 *
 * The run is sized from the bar's own width (`--track`, set below)
 * because the keyframes travel in px, not percentages - a percentage in
 * a transform resolves against the coin, not the bar, which is how the
 * first attempt sent them all flying off the end of a 560px strip.
 *
 * Delays are deliberately negative: a coin given `animation-delay: -3s`
 * starts three seconds into its run, so the bar is already populated on
 * the first frame instead of one coin entering an empty strip.
 */
function fillSlidingCoins(bar) {
  if (!bar) return;
  const host = bar.querySelector(".success-splash-coins");
  if (!host) return;

  const track = bar.clientWidth || 520;
  host.style.setProperty("--track", track + "px");

  const lanes = 2;
  const laneHeight = bar.clientHeight || 64;

  for (let row = 0; row < lanes; row++) {
    /* Odd lanes reverse direction (see .is-reverse) so the coins are
       not all travelling the same way. */
    const lane = document.createElement("div");
    lane.className = "splash-coin-track" + (row % 2 ? " is-reverse" : "");
    host.appendChild(lane);

    const y = ((row + 0.5) / lanes) * laneHeight;
    const perLane = 3;

    for (let i = 0; i < perLane; i++) {
      const size = Math.round(30 + Math.random() * 16);
      const coin = document.createElement("div");
      coin.className = "splash-coin";

      const face = document.createElement("img");
      face.className = "splash-coin-face";
      face.alt = "";
      face.decoding = "async";
      face.width = size;
      face.height = size;
      face.src = COIN_ASSETS[(row + i) % COIN_ASSETS.length];

      Object.assign(coin.style, {
        top: Math.round(y - size / 2) + "px",
        width: size + "px",
        height: size + "px",
        "--bob": Math.round((Math.random() - 0.5) * 10) + "px",
        "--slide-dur": (5 + Math.random() * 4).toFixed(2) + "s",
        "--slide-delay": (-Math.random() * 9).toFixed(2) + "s",
        "--spin-delay": (-Math.random() * 2.8).toFixed(2) + "s",
      });
      coin.appendChild(face);
      lane.appendChild(coin);
    }
  }
}

/**
 * Roll the total up to its real value so it lands with the tick rather
 * than sitting there already finished, then pop it.
 */
function countUpAmount(el, totalPaise) {
  if (!el) return;
  if (prefersReducedMotion() || totalPaise <= 0) {
    el.textContent = formatINR(totalPaise);
    return;
  }

  const DURATION = 560;
  /* Wait out the element's own entrance, or the total finishes counting
     up while it is still faded out and nobody sees it land. */
  const startedAt = performance.now() + 200;
  const step = (now) => {
    if (!el.isConnected) return;
    if (now < startedAt) {
      requestAnimationFrame(step);
      return;
    }
    const t = Math.min(1, (now - startedAt) / DURATION);
    const eased = 1 - Math.pow(1 - t, 3);
    const done = t === 1;
    el.textContent = formatINR(done ? totalPaise : Math.round(totalPaise * eased));
    if (done) el.classList.add("is-final");
    else requestAnimationFrame(step);
  };
  el.textContent = formatINR(0);
  requestAnimationFrame(step);
}

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (_) {
    return false;
  }
}

/**
 * The confirmation a saved sale gets, from outside this module.
 *
 * One celebration, one code path: the scanner books a multi-line bill
 * as several sales without ever opening this form, and the shop should
 * not be able to tell which door the money came in by.
 */
export function celebrateSavedSale({
  totalPaise = 0,
  serviceName = "",
  quantity = null,
  ratePaise = null,
  customerName = "",
  method = "cash",
} = {}) {
  playCoinSound();
  showCoinBurst();
  showSuccessSplash({
    totalPaise,
    serviceName,
    quantity,
    ratePaise,
    customerName,
    method,
    online: navigator.onLine,
  });
}

/* =========================================================
   External prefill API (used by Scan Receipt / AI extraction)
   -----------------------------------------------------------------
   Safe to call any time — if the modal hasn't been built yet it
   is lazily built; if a value is omitted it is not touched.
   ========================================================= */

/**
 * Pre-fill the record-a-sale form from an external source.
 * Does NOT open or close the modal — caller decides visibility.
 *
 * @param {object} opts
 * @param {string} [opts.serviceId]  catalog service id — if not found in loaded list, the
 *                                   picker's text field is pre-filled with fallbackServiceName
 * @param {string} [opts.serviceNameFallback]  typed into the picker when serviceId doesn't match
 * @param {number} [opts.quantity]   integer ≥ 1
 * @param {number} [opts.rateRupees] rate in RUPEES (not paise)
 * @param {string} [opts.customerName]
 * @param {"cash"|"upi"|"card"|"due"} [opts.paymentMethod]
 * @param {string} [opts.dateKey]  business day to file the entry under
 * @param {string} [opts.receiptImage]  JPEG data URL to keep with the entry
 * @param {{name: string, candidates?: object[]}} [opts.scanned]  the name the
 *   bill printed, when the catalog has no service for it. Shown, with the
 *   closest services to choose from, instead of leaving the form to refuse
 *   the save.
 */
export function prefillSaleForm({
  serviceId = "",
  serviceNameFallback = "",
  quantity = null,
  rateRupees = null,
  customerName = null,
  paymentMethod = null,
  dateKey = null,
  receiptImage = null,
  scanned = null,
} = {}) {
  if (!overlay) overlay = buildOverlay();
  const root = overlay;

  // Business day: an extracted receipt belongs to a specific day, so the
  // scanner can name it and the entry lands there instead of on tonight.
  if (dateKey !== null && dateKey !== undefined && String(dateKey).trim()) {
    setTargetDate(dateKey);
  }

  /* The photograph itself, when the scanner kept one for the ledger. It is
     offered, not imposed: if it is too big to store, setReceiptImage says so
     and the sale is still saved, just without the photo. */
  if (receiptImage) setReceiptImage(receiptImage);

  // Service: try setValue by id first
  if (serviceId && picker && services.some((s) => s.serviceId === serviceId)) {
    selectedService = services.find((s) => s.serviceId === serviceId);
    try { picker.setValue(serviceId); } catch (_) { /* noop */ }
  } else if (serviceNameFallback) {
    // Typed fallback — user can pick match from dropdown or "Add service"
    const input = root.querySelector(".svc-pick-input");
    if (input) {
      input.value = String(serviceNameFallback).slice(0, 80);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  /* A name the catalog does not have. Shown AFTER the search box is
     seeded, because the panel is the answer to the question the
     filtered list cannot answer: with the name in the box, the list
     offers near misses, and the panel offers the same few by name
     (and the option to add one) without a keystroke. */
  if (scanned && scanned.name) {
    showScanSuggest(scanned.name, scanned.candidates);
  }

  // Quantity
  if (quantity !== null && quantity !== undefined) {
    const q = Number(quantity);
    if (Number.isFinite(q) && q >= 1) {
      const el = root.querySelector("#qtyInput");
      if (el) { el.value = String(Math.max(1, Math.floor(q))); el.dispatchEvent(new Event("input")); }
    }
  }

  // Rate (rupees)
  if (rateRupees !== null && rateRupees !== undefined) {
    const r = Number(rateRupees);
    if (Number.isFinite(r) && r >= 0) {
      const el = root.querySelector("#rateInput");
      if (el) {
        const pretty = (Math.round(r * 100) / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
        el.value = pretty;
        el.dispatchEvent(new Event("input"));
      }
    }
  }

  // Customer
  if (customerName !== null && customerName !== undefined) {
    const el = root.querySelector("#customerInput");
    if (el) el.value = String(customerName).slice(0, 120);
  }

  // Payment method
  if (paymentMethod && isPaymentMethod(paymentMethod)) {
    const methodRow = root.querySelector("#methodRow");
    const btn = methodRow && methodRow.querySelector(`.seg-btn[data-method="${paymentMethod}"]`);
    if (btn && !btn.classList.contains("is-active")) btn.click();
  }

  updateTotal();
}



