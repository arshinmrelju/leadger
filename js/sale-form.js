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
  escapeHtml,
} from "./utils.js";
import {
  fetchServices,
  createService,
  createTransaction,
  flushPendingWrites,
  isNetworkError,
} from "./ledger.js";
import { reportError } from "./auth.js";

const ICON_PLUS =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

/* ---------------- State ---------------- */

let overlay = null;
let services = [];
let selectedService = null;
let paymentMethod = "cash";
let saving = false;
let waitingSync = false;
const listeners = new Set();

/** Subscribe to successful saves. Returns an unsubscribe function. */
export function onSaleRecorded(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
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

    '<div class="field">' +
    '<label for="serviceSelect">Service *</label>' +
    '<select class="select" id="serviceSelect" required></select>' +
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
    '<button type="button" class="seg-btn seg-cash is-active" data-method="cash">Cash</button>' +
    '<button type="button" class="seg-btn seg-upi" data-method="upi">UPI</button>' +
    '<button type="button" class="seg-btn seg-card" data-method="card">Card</button>' +
    '<button type="button" class="seg-btn seg-due" data-method="due">Due</button>' +
    "</div>" +
    '<span class="field-hint" id="methodHint">Recorded as paid.</span>' +
    "</div>" +

    '<div class="field"><label for="customerInput">Customer <span class="small muted">(optional)</span></label>' +
    '<input class="input" id="customerInput" type="text" maxlength="120" autocomplete="off" placeholder="Customer name" /></div>' +

    '<div class="entry-total" aria-live="polite">' +
    '<span class="entry-total-label">Total</span>' +
    '<span class="entry-total-value" id="totalPreview">' +
    formatINR(0) +
    "</span>" +
    "</div>" +

    '<button type="submit" class="btn btn-primary btn-lg btn-block mt-1" id="saveBtn">' +
    "Save transaction" +
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
    '<h3 id="saleModalTitle">Record a sale</h3>' +
    '<button type="button" class="modal-close" data-close aria-label="Close">&times;</button>' +
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
  wire(el);
  return el;
}

/* ---------------- Open / close ---------------- */

/**
 * Open the record-a-sale dialog.
 * @param {object} [opts]
 * @param {string} [opts.serviceId] preselect a service (e.g. from a quick tile)
 */
export function openSaleForm({ serviceId = "" } = {}) {
  if (!overlay) overlay = buildOverlay();

  hideFormMsg();
  closeAddServiceBox();
  resetForm();
  openModal(overlay);
  renderQuickGrid();

  /* Services are cheap to re-read (Firestore serves from cache) and the
     catalog may have changed since the last sale, so refresh every open. */
  refreshServices()
    .then(() => {
      if (serviceId) pickService(serviceId);
    })
    .catch(() => {});
}

export function closeSaleForm() {
  if (overlay) closeModal(overlay);
}

/** Ctrl+N anywhere in the app opens the same dialog. */
window.addEventListener("seva:new-txn", () => openSaleForm());

/* ---------------- Wiring ---------------- */

function wire(root) {
  const addBox = root.querySelector("#addServiceBox");

  root.querySelector("#addServiceToggle").addEventListener("click", () => {
    addBox.classList.toggle("is-hidden");
    if (!addBox.classList.contains("is-hidden")) {
      setTimeout(() => root.querySelector("#newServiceName").focus(), 40);
    }
  });
  root.querySelector("#addServiceCancel").addEventListener("click", closeAddServiceBox);
  root.querySelector("#addServiceSave").addEventListener("click", saveNewService);

  root.querySelector("#serviceSelect").addEventListener("change", (e) => {
    const id = e.target.value;
    if (!id) {
      selectedService = null;
      root.querySelector("#rateInput").value = "";
    } else {
      pickService(id);
    }
    updateTotal();
  });

  root.querySelector("#qtyInput").addEventListener("input", updateTotal);
  root.querySelector("#rateInput").addEventListener("input", updateTotal);

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
  renderServiceSelect();
  renderQuickGrid();
}

function renderServiceSelect() {
  const sel = overlay.querySelector("#serviceSelect");
  sel.innerHTML =
    '<option value="">Select a service&hellip;</option>' +
    services
      .map(
        (s) =>
          '<option value="' +
          escapeHtml(s.serviceId) +
          '">' +
          escapeHtml(s.name) +
          (s.pricePaise > 0 ? " \u00B7 " + formatINR(s.pricePaise) : "") +
          "</option>"
      )
      .join("");
}

function quickCode(s) {
  const fromName = (s.name || "")
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase();
  return (s.code || fromName || "SV").slice(0, 2);
}

function renderQuickGrid() {
  const grid = overlay && overlay.querySelector("#saleQuickGrid");
  const hint = overlay && overlay.querySelector("#saleQuickHint");
  if (!grid) return;

  grid.innerHTML =
    services
      .slice(0, 16)
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
    '<div class="state" style="padding:0.75rem 0;"><p class="muted" style="margin:0;">No services yet — use \u201CAdd service\u201D above to create your first one.</p></div>';

  grid.querySelectorAll(".quick-service").forEach((btn) => {
    btn.addEventListener("click", () => pickService(btn.dataset.id));
  });

  if (hint) {
    hint.textContent = services.length
      ? "Tap a service to fill the form."
      : "No services yet \u2014 use \u201CAdd service\u201D above to create your first one.";
  }
}

function pickService(id) {
  if (!overlay) return;
  const svc = services.find((s) => s.serviceId === id);
  if (!svc) return;
  selectedService = svc;
  overlay.querySelector("#serviceSelect").value = id;
  overlay.querySelector("#rateInput").value = paiseToInput(svc.pricePaise);
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

  saving = true;
  const btn = overlay.querySelector("#saveBtn");
  setLoading(btn, true);
  try {
    const result = await createTransaction({
      serviceId: selectedService.serviceId,
      serviceName: selectedService.name,
      quantity: qty,
      rate: ratePaise / 100, // paise -> rupees input for createTransaction
      paymentMethod,
      customerName: customer,
      dateKey: todayKolkata(),
    });

    if (navigator.onLine) {
      toast("Transaction saved \u2014 " + formatINR(result.totalPaise) + ".", "success");
    } else {
      toast("Saved offline \u2014 " + formatINR(result.totalPaise) + ". Will sync automatically.", "success", 5200);
      if (!waitingSync) scheduleSyncConfirmation();
    }

    emit(result);
    resetForm();
    overlay.querySelector("#qtyInput").focus();
  } catch (err) {
    console.error("[trustx-ledger] save:", err);
    showFormMsg(
      isNetworkError(err) ? "Could not save right now. Check your connection and try again." : reportError(err)
    );
  } finally {
    saving = false;
    setLoading(btn, false);
  }
}

/** Clear the entry fields, keeping the chosen service and method. */
function resetForm() {
  if (!overlay) return;
  overlay.querySelector("#qtyInput").value = "1";
  overlay.querySelector("#rateInput").value = selectedService ? paiseToInput(selectedService.pricePaise) : "";
  overlay.querySelector("#customerInput").value = "";
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
