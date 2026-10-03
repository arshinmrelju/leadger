/* =========================================================
   TrustX Ledger — Per-sale actions: edit, settle, delete
   -----------------------------------------------------------------
   There is exactly ONE way to fix a sale that was recorded wrong,
   and it lives here. Every screen that lists sales — the daily
   ledger and the all-time history — draws its row buttons with
   `txnActionButtons()` and delegates its clicks to
   `handleTxnAction()`, so a correction behaves the same wherever
   the shopkeeper happens to find the row.

   Same reasoning as js/sale-form.js, the other shared dialog: the
   edit dialog is built lazily on first use and reused afterwards,
   and the service catalog is read once and cached, because it
   rarely changes within a session.

   The money is js/ledger.js's job — those calls keep the day's head
   in step in the same batch. This module only decides what a
   correction looks like, and what a refused write says.

   The row handed in is UPDATED IN PLACE on a successful edit, which
   is what lets a page re-render from its own array instead of
   paying for another read. `onChange` then tells the page what
   happened so it can drop a deleted row and redraw.
   ========================================================= */

import { toast, setLoading, confirm, openModal, closeModal } from "./app.js";
import {
  formatINR,
  paiseToInput,
  sanitizeQuantity,
  rateToPaise,
  computeTotalPaise,
  methodLabel,
  escapeHtml,
} from "./utils.js";
import { formatEntryTime } from "./day-ledger.js";
import {
  fetchServices,
  fetchDayState,
  fetchMonthHeads,
  fetchTransactions,
  updateTransaction,
  deleteTransaction,
  markTransactionPaid,
  fetchReceiptImage,
  isNetworkError,
} from "./ledger.js";
import { auditDayCounters, describeRefusal, planDayRepair } from "./day-audit.js";
import { reportError } from "./auth.js";
import { isQuotaExhausted, quotaResetTime } from "./quota.js";

/* ---------------- Icons ---------------- */

const ICON_EDIT =
  '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

const ICON_TRASH =
  '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

const ICON_PENCIL =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

const ICON_CLOSE =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

const ICON_CASH =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/></svg>';

const ICON_UPI =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 18h6"/></svg>';

const ICON_CARD =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>';

const ICON_DUE =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';

const ICON_RECEIPT =
  '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2h16v20l-2.5-1.5L15 22l-2.5-1.5L10 22l-2.5-1.5L5 22V4a2 2 0 0 1 2-2z"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>';

/* ---------------- State ---------------- */

/* Names where a closed day can be re-opened, because "it is closed" on
   its own is a dead end: the shop's next move is to reopen the day from
   the Daily Ledger page, and it should not have to go looking for how. */
const CLOSED_DAY_MSG =
  "This business day is closed, so its sales can no longer be changed. Reopen it from the Daily Ledger page to make a correction.";

let overlay = null;    // the edit dialog, built on first use
let services = null;   // catalog for the picker; null until the first read
let editing = null;    // the row currently open in the dialog
let editMethod = "cash";
let saving = false;    // double-submit guard

/* ---------------- Row markup ---------------- */

/** A due sale that has not been settled is the only one with a third action. */
function isDuePending(t) {
  return t && t.paymentMethod === "due" && t.status === "pending";
}

/**
 * The action buttons for one sale row.
 *
 * `closed` greys them out for a day that can no longer be written to.
 * It is only a hint: the rules decide, and a click on a stale row is
 * still turned into a sentence the shop can act on (see CLOSED_DAY_MSG).
 *
 * The receipt button is the exception to all of that: looking at the
 * photograph of a sale is a read, and a closed day is still worth
 * reading — closing a day locks the money, it does not hide it.
 *
 * @param {object} t  a normalized transaction row
 * @param {object} [opts]
 * @param {boolean} [opts.closed]  the row's business day is closed
 */
export function txnActionButtons(t, { closed = false } = {}) {
  const id = escapeHtml(t.txnId);
  const off = closed ? " disabled" : "";

  return (
    (t.hasReceipt
      ? '<button class="btn btn-secondary btn-sm" type="button" data-act="receipt" data-id="' +
        id + '" title="View receipt photo" aria-label="View receipt photo">' + ICON_RECEIPT + "</button>"
      : "") +
    (isDuePending(t)
      ? '<button class="btn btn-success btn-sm" type="button" data-act="paid" data-id="' +
        id + '" title="Mark this due as paid"' + off + ">Mark paid</button>"
      : "") +
    '<button class="btn btn-secondary btn-sm" type="button" data-act="edit" data-id="' +
      id + '" title="Edit sale" aria-label="Edit sale"' + off + ">" + ICON_EDIT + "</button>" +
    '<button class="btn btn-danger-soft btn-sm" type="button" data-act="delete" data-id="' +
      id + '" title="Delete sale" aria-label="Delete sale"' + off + ">" + ICON_TRASH + "</button>"
  );
}

/**
 * Delegated click handler for a table body full of `txnActionButtons()`.
 *
 * Looks the row up by id in `rows` — the buttons never carry the sale's
 * details, so there is nothing to keep in sync with the table markup.
 *
 * @param {Event} event
 * @param {object} ctx
 * @param {object[]} ctx.rows        every row the table is showing
 * @param {Function} [ctx.isClosed]  `(row) => boolean`; the page's own
 *   knowledge of which days are closed, if it has any
 * @param {Function} [ctx.onChange]  `({action, row, result})` after a
 *   successful write; the page drops a deleted row and redraws
 * @returns {Promise<boolean>} whether a change was made
 */
export async function handleTxnAction(event, { rows = [], isClosed = null, onChange = null } = {}) {
  const btn = event.target.closest("button[data-act]");
  if (!btn || btn.disabled) return false;

  const id = btn.getAttribute("data-id");
  const row = rows.find((r) => r.txnId === id);
  if (!row) return false;

  const action = btn.getAttribute("data-act");
  const closed = typeof isClosed === "function" ? isClosed(row) === true : false;

  /* Reading the receipt changes nothing, so it does not go through the
     write path below: no day check, no confirmation, no redraw. It still
     reports true, because it was handled. */
  if (action === "receipt") return viewReceipt(row);

  let ok = false;

  if (action === "edit") ok = await editRow(row, closed);
  else if (action === "delete") ok = await deleteRow(row, closed);
  else if (action === "paid") ok = await settleRow(row, closed);
  if (!ok) return false;

  if (typeof onChange === "function") onChange({ action, row });
  return true;
}

/**
 * Turn a failed write into something actionable.
 *
 * A rules rejection on a closed day is worth calling out by name, since
 * a page only knows a day is closed once its own read has caught up —
 * another device can close the day while a list is on screen.
 */
function describeWriteError(err, closed) {
  /* Checked before the offline branch, because the two feel similar and
     the remedies are opposite: a queued write recovers by itself when the
     connection returns, a quota refusal never recovers on its own. */
  if (isQuotaExhausted(err)) {
    const resetAt = quotaResetTime();
    return (
      "This shop has used up today's free Firebase limit, so the change was NOT saved" +
      (resetAt ? ` and cannot be until it resets around ${resetAt}.` : " and cannot be until the limit resets.")
    );
  }
  if (isNetworkError(err)) {
    return "You appear to be offline. The change will sync when you reconnect.";
  }
  const msg = String((err && err.message) || "").toLowerCase();
  if (msg.includes("permission") || msg.includes("insufficient")) {
    /* Firestore reports a denial only as "permission-denied" and never names
       the clause that failed, so neither cause can be asserted from here —
       only offered. Naming just the closed day sent shops after the wrong
       thing: a day whose head has drifted out of step with its sales refuses
       every edit, settle and delete while still accepting new sales, and
       reopening it changes nothing. */
    return closed
      ? CLOSED_DAY_MSG
      : "The ledger was not allowed to change that sale. If the day was just closed, reopen it and try again. " +
        "Otherwise the day's totals may be out of step with its sales — the Developer console's " +
        "Day integrity check will name the day and the difference.";
  }
  return reportError(err);
}

/** Rows a refusal diagnosis reads. A day is read whole. */
const DIAGNOSIS_ROW_LIMIT = 1000;

/**
 * When the rules refuse a change, work out which number is wrong
 * instead of passing the refusal on.
 *
 * A bare "not allowed" is the one error in this app the shop cannot act
 * on, because the cause is a comparison the client never sees: the day's
 * head has to equal the exact sum of that day's sales. Everything needed
 * to check it is already in the database, so it is checked here and the
 * answer goes in the toast — the day, the field, and whether the ledger
 * can put it right on its own.
 *
 * The day's sales are read rather than taken from the table on screen:
 * the table may be showing one page of several, and adding up half a day
 * would name a difference that is not there. `fetchTransactions` caches,
 * so this normally costs nothing after the list has been drawn.
 *
 * Any failure of its own is swallowed. A diagnosis that throws must not
 * replace the write error the shop was actually shown.
 *
 * @param {object} row  the sale whose change was refused
 * @returns {Promise<{audit: object, plan: object}|null>} null if it could
 *   not be worked out
 */
async function diagnoseRefusedDay(row) {
  const dateKey = String((row && row.dateKey) || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;

  try {
    const [heads, rows] = await Promise.all([
      fetchMonthHeads({ yearMonth: dateKey.slice(0, 7) }),
      fetchTransactions({ dateKey, limit: DIAGNOSIS_ROW_LIMIT }),
    ]);
    const head = heads[dateKey] || null;
    const audit = auditDayCounters({
      dateKey,
      head: head ? { state: head.state, counters: head.counters } : null,
      rows,
      truncated: rows.length >= DIAGNOSIS_ROW_LIMIT,
    });
    /* Planned from this report and no other sum, so the toast and the
       repair can never quote different numbers. */
    return { audit, plan: planDayRepair(audit) };
  } catch (err) {
    console.error("[trustx-ledger] refusal diagnosis:", err);
    return null;
  }
}

/**
 * The sentence a refusal earns, with the cause named when it can be
 * found. Falls back to the plain explanation whenever the day cannot be
 * checked, so this can only ever be more specific, never wrong.
 *
 * @param {Error} err
 * @param {boolean} closed  the page's own knowledge of the day
 * @param {object} [row]    the sale the change was about
 * @returns {Promise<string>}
 */
async function describeRefusedWrite(err, closed, row) {
  const plain = describeWriteError(err, closed);
  if (closed || !row) return plain;

  const msg = String((err && err.message) || "").toLowerCase();
  if (!msg.includes("permission") && !msg.includes("insufficient")) return plain;

  const found = await diagnoseRefusedDay(row);
  if (!found) return plain;

  return describeRefusal(found.audit, found.plan);
}

/**
 * Refuse a correction on a closed day before the shop fills the dialog
 * in. The rules refuse it too, but Firestore reports a denial only as
 * "permission-denied", never naming the clause — so without this the
 * shop types a whole correction and is then told the rules are out of
 * date, which is both wrong and unactionable.
 *
 * `fetchDayState` fails OPEN (an unreadable day reads as open), so a
 * dropped connection can never block the counter: the server stays the
 * authority and this only makes a predictable refusal legible.
 */
async function assertDayOpen(row) {
  const day = await fetchDayState(row.dateKey);
  if (day.closed) throw new Error(CLOSED_DAY_MSG);
}

/* ---------------- Edit dialog ---------------- */

function editFormMarkup() {
  return (
    '<form id="txnEditForm" novalidate>' +
    '<div class="modal-body">' +

    '<div class="txn-edit-total">' +
    '<span class="muted">Recorded <span id="txnEditStamp">&mdash;</span></span>' +
    '<b id="txnEditTotal">' + formatINR(0) + "</b>" +
    "</div>" +

    '<div class="field">' +
    '<label for="txnEditService">Service</label>' +
    '<select class="input" id="txnEditService"></select>' +
    "</div>" +

    '<div class="form-row">' +
    '<div class="field"><label for="txnEditQty">Quantity</label>' +
    '<input class="input" id="txnEditQty" type="number" inputmode="numeric" min="1" max="100000" step="1" value="1" /></div>' +
    '<div class="field"><label for="txnEditRate">Rate (&#x20B9;)</label>' +
    '<input class="input" id="txnEditRate" type="text" inputmode="decimal" placeholder="0.00" /></div>' +
    "</div>" +

    '<div class="field">' +
    "<label>Payment method</label>" +
    '<div class="seg-row" id="txnEditMethodRow" role="group" aria-label="Payment method">' +
    '<button class="seg-btn seg-cash" type="button" data-method="cash">' + ICON_CASH + "Cash</button>" +
    '<button class="seg-btn seg-upi" type="button" data-method="upi">' + ICON_UPI + "UPI</button>" +
    '<button class="seg-btn seg-card" type="button" data-method="card">' + ICON_CARD + "Card</button>" +
    '<button class="seg-btn seg-due" type="button" data-method="due">' + ICON_DUE + "Due</button>" +
    "</div>" +
    '<span class="field-hint" id="txnEditMethodHint"></span>' +
    "</div>" +

    '<div class="field">' +
    '<label for="txnEditStatus">Status</label>' +
    '<select class="input" id="txnEditStatus">' +
    '<option value="paid">Paid</option>' +
    '<option value="pending">Pending (unpaid)</option>' +
    "</select>" +
    '<p class="small muted" id="txnEditStatusHint"></p>' +
    "</div>" +

    '<div class="field">' +
    '<label for="txnEditCustomer">Customer <span class="small muted">(optional)</span></label>' +
    '<input class="input" id="txnEditCustomer" type="text" maxlength="120" autocomplete="off" placeholder="Customer name" />' +
    "</div>" +

    '<p class="small text-danger is-hidden" id="txnEditError" role="alert"></p>' +
    "</div>" +

    '<div class="modal-footer txn-edit-actions">' +
    '<button class="btn btn-secondary" type="button" data-close>Cancel</button>' +
    '<button class="btn btn-primary" type="submit" id="txnEditSave">Save changes</button>' +
    "</div>" +
    "</form>"
  );
}

function buildOverlay() {
  const el = document.createElement("div");
  el.className = "modal-overlay";
  el.id = "txnEditModal";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "txnEditTitle");
  el.innerHTML =
    '<div class="modal txn-edit" role="document">' +
    '<div class="modal-header">' +
    '<div class="modal-header-icon modal-header-icon-edit" aria-hidden="true">' + ICON_PENCIL + "</div>" +
    '<div class="modal-header-text">' +
    '<h3 id="txnEditTitle">Edit sale</h3>' +
    '<p class="modal-header-sub">Update service, price, customer or payment mode</p>' +
    "</div>" +
    '<button class="modal-close" type="button" data-close aria-label="Close">' + ICON_CLOSE + "</button>" +
    "</div>" +
    editFormMarkup() +
    "</div>";
  document.body.appendChild(el);
  wireOverlay(el);
  return el;
}

function wireOverlay(el) {
  el.querySelector("#txnEditQty").addEventListener("input", updateEditTotal);
  el.querySelector("#txnEditRate").addEventListener("input", updateEditTotal);
  el.querySelectorAll("#txnEditMethodRow .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      editMethod = btn.getAttribute("data-method");
      paintMethod();
      syncStatusControl();
      updateEditTotal();
    });
  });
  el.querySelector("#txnEditForm").addEventListener("submit", saveEdit);
}

/* ---------------- Services ---------------- */

async function loadServices() {
  if (services) return services;
  try {
    services = await fetchServices();
  } catch (err) {
    /* The catalog is a nicety here — updateTransaction re-reads the
       service on the server anyway — so a failure must not stop a
       shopkeeper fixing a bad row. */
    console.warn("[trustx-ledger] services for edit:", err);
    services = [];
  }
  return services;
}

function fillServiceOptions(row) {
  const sel = overlay.querySelector("#txnEditService");
  sel.innerHTML = services
    .map(
      (s) =>
        '<option value="' + escapeHtml(s.serviceId) + '"' +
        (s.serviceId === row.serviceId ? " selected" : "") + ">" +
        escapeHtml(s.name) +
        " \u00B7 " + formatINR(s.pricePaise) +
        "</option>"
    )
    .join("");

  /* A sale whose service has since been archived still has to be
     readable here, so its own service is offered as a labelled option.
     Picking it cannot be saved — the rules refuse an archived service —
     which is why it says so in the label rather than hiding it. */
  if (row.serviceId && !services.some((s) => s.serviceId === row.serviceId)) {
    sel.insertAdjacentHTML(
      "afterbegin",
      '<option value="' + escapeHtml(row.serviceId) + '" selected>' +
        escapeHtml(row.serviceName) + " (archived)</option>"
    );
  }
}

/* ---------------- Open / save ---------------- */

function showEditError(message) {
  const box = overlay && overlay.querySelector("#txnEditError");
  if (!box) return;
  box.textContent = message;
  box.classList.remove("is-hidden");
}

function hideEditError() {
  const box = overlay && overlay.querySelector("#txnEditError");
  if (box) box.classList.add("is-hidden");
}

/** Open the dialog on a row, filling it from the sale as recorded. */
async function editRow(row, closed) {
  if (closed) {
    toast(CLOSED_DAY_MSG, "error");
    return false;
  }

  const day = await fetchDayState(row.dateKey);
  if (day.closed) {
    toast(CLOSED_DAY_MSG, "error");
    return false;
  }

  if (!overlay) overlay = buildOverlay();
  await loadServices();

  editing = row;
  editMethod = row.paymentMethod;
  hideEditError();

  overlay.querySelector("#txnEditStamp").textContent = formatEntryTime(row.createdAt);
  overlay.querySelector("#txnEditQty").value = String(row.quantity);
  overlay.querySelector("#txnEditRate").value = paiseToInput(row.ratePaise);
  overlay.querySelector("#txnEditCustomer").value = row.customerName || "";
  fillServiceOptions(row);

  paintMethod();
  syncStatusControl();
  updateEditTotal();
  openModal(overlay);
  return true;
}

function paintMethod() {
  overlay.querySelectorAll("#txnEditMethodRow .seg-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.getAttribute("data-method") === editMethod);
  });
  const hint = overlay.querySelector("#txnEditMethodHint");
  if (hint) {
    hint.textContent =
      editMethod === "due"
        ? "Recorded as pending \u2014 it counts as due until it is paid."
        : "Recorded as paid (" + methodLabel(editMethod) + ").";
  }
}

/**
 * A non-due sale is settled by definition, so the status control is
 * locked for everything except a due sale.
 */
function syncStatusControl() {
  const statusSel = overlay.querySelector("#txnEditStatus");
  const hint = overlay.querySelector("#txnEditStatusHint");
  const isDue = editMethod === "due";

  statusSel.disabled = !isDue;
  if (isDue) {
    statusSel.value = editing && editing.status === "paid" ? "paid" : "pending";
    hint.textContent = "A due sale can be marked paid or left unpaid.";
  } else {
    statusSel.value = "paid";
    hint.textContent = "This sale is settled by definition.";
  }
}

function updateEditTotal() {
  if (!overlay) return;
  const qty = sanitizeQuantity(overlay.querySelector("#txnEditQty").value);
  const ratePaise = rateToPaise(overlay.querySelector("#txnEditRate").value);
  const total = computeTotalPaise(qty, ratePaise);
  const out = overlay.querySelector("#txnEditTotal");
  if (out) out.textContent = formatINR(total === null ? 0 : total);
}

async function saveEdit(event) {
  event.preventDefault();
  if (saving || !editing) return;
  hideEditError();

  const qty = sanitizeQuantity(overlay.querySelector("#txnEditQty").value);
  if (qty === null) {
    showEditError("Quantity must be a whole number greater than 0.");
    return;
  }

  /* The rate field is rupees, so it goes through the same parser the
     record-a-sale dialog uses rather than a local rounding. */
  const ratePaise = rateToPaise(overlay.querySelector("#txnEditRate").value);
  if (ratePaise === null) {
    showEditError("Enter a valid rate (\u20B90 or more, up to \u20B91,00,000).");
    return;
  }
  if (computeTotalPaise(qty, ratePaise) === null) {
    showEditError("The total is out of the allowed range.");
    return;
  }

  const serviceId = overlay.querySelector("#txnEditService").value;
  const customerName = overlay.querySelector("#txnEditCustomer").value;
  const status = editMethod === "due" ? overlay.querySelector("#txnEditStatus").value : "paid";

  saving = true;
  const saveBtn = overlay.querySelector("#txnEditSave");
  setLoading(saveBtn, true);
  try {
    /* Re-read the day on the way out: another device can close it
       while the dialog is open, and filling in a whole correction only
       to be refused is the case worth pre-empting. */
    await assertDayOpen(editing);

    const result = await updateTransaction(editing.txnId, editing.dateKey, {
      serviceId,
      quantity: qty,
      ratePaise,
      paymentMethod: editMethod,
      status,
      customerName,
    });

    applyEdit(editing, {
      quantity: qty,
      ratePaise,
      totalPaise: result.totalPaise,
      paymentMethod: editMethod,
      status: result.status,
      service: services.find((s) => s.serviceId === serviceId) || null,
      customerName: String(customerName || "").trim(),
    });

    closeModal(overlay);
    editing = null;
    toast("Sale updated.", "success");
    return true;
  } catch (err) {
    console.error("[trustx-ledger] edit:", err);
    setLoading(saveBtn, false);
    showEditError(await describeRefusedWrite(err, false, row));
    return false;
  } finally {
    saving = false;
  }
}

/**
 * Fold a saved correction back into the row the page is holding, so the
 * list redraws without another read. The collected/due split is
 * re-derived the same way js/ledger.js derives it when it normalizes a
 * document, so an edited row looks exactly like a freshly read one.
 */
function applyEdit(row, patch) {
  row.quantity = patch.quantity;
  row.ratePaise = patch.ratePaise;
  row.totalPaise = patch.totalPaise;
  row.paymentMethod = patch.paymentMethod;
  row.methodLabel = methodLabel(patch.paymentMethod);
  row.status = patch.status;
  row.collectedPaise = patch.paymentMethod === "due" ? 0 : patch.totalPaise;
  row.duePaise = patch.paymentMethod === "due" ? patch.totalPaise : 0;
  row.customerName = patch.customerName;
  if (patch.service) {
    row.serviceId = patch.service.serviceId;
    row.serviceName = patch.service.name;
  }
}

/* ---------------- Receipt viewer ---------------- */

/**
 * The photograph is not on the sale: it is its own document, read only
 * when someone actually asks to see it. The cache inside fetchReceiptImage
 * means a second look at the same bill costs nothing, and a day of listing
 * sales never downloads a single photograph.
 */
let receiptOverlay = null;   // built on first use, like the edit dialog

function buildReceiptOverlay() {
  const el = document.createElement("div");
  el.className = "modal-overlay";
  el.id = "receiptModal";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "receiptTitle");
  el.innerHTML =
    '<div class="modal receipt-view" role="document">' +
    '<div class="modal-header">' +
    '<div class="modal-header-icon modal-header-icon-edit" aria-hidden="true">' + ICON_RECEIPT + "</div>" +
    '<div class="modal-header-text">' +
    '<h3 id="receiptTitle">Receipt photo</h3>' +
    '<p class="modal-header-sub" id="receiptSub"></p>' +
    "</div>" +
    '<button class="modal-close" type="button" data-close aria-label="Close">' + ICON_CLOSE + "</button>" +
    "</div>" +
    '<div class="modal-body receipt-view-body">' +
    '<p class="muted" id="receiptMsg">Loading the photo…</p>' +
    '<img class="receipt-view-img is-hidden" id="receiptImg" alt="Photograph of the receipt for this sale" />' +
    "</div>" +
    '<div class="modal-footer">' +
    '<a class="btn btn-secondary is-hidden" id="receiptSave" download="receipt.jpg">Save photo</a>' +
    '<button class="btn btn-primary" type="button" data-close>Close</button>' +
    "</div>" +
    "</div>";
  document.body.appendChild(el);
  return el;
}

async function viewReceipt(row) {
  if (!receiptOverlay) receiptOverlay = buildReceiptOverlay();

  const msg = receiptOverlay.querySelector("#receiptMsg");
  const img = receiptOverlay.querySelector("#receiptImg");
  const save = receiptOverlay.querySelector("#receiptSave");
  const sub = receiptOverlay.querySelector("#receiptSub");

  sub.textContent =
    row.serviceName + " · " + formatINR(row.totalPaise) + " · " + methodLabel(row.paymentMethod);
  msg.classList.remove("is-hidden");
  msg.textContent = "Loading the photo…";
  img.classList.add("is-hidden");
  img.removeAttribute("src");
  save.classList.add("is-hidden");
  save.removeAttribute("href");

  /* Stamped before the await below, so a read that comes back late can
     tell it is no longer answering the dialog on screen. */
  receiptOverlay.setAttribute("data-receipt", row.txnId + "|" + row.dateKey);
  openModal(receiptOverlay);

  let dataUrl;
  try {
    dataUrl = await fetchReceiptImage(row.txnId, row.dateKey);
  } catch (err) {
    console.error("[trustx-ledger] receipt image:", err);
    dataUrl = null;
  }

  /* The dialog may have been closed, or another receipt opened, while the
     read was in flight — painting into a stale dialog would show the wrong
     bill, so the row that is on screen is checked first. */
  const wanted = row.txnId + "|" + row.dateKey;
  if (receiptOverlay.getAttribute("data-receipt") !== wanted) return true;
  if (!receiptOverlay.classList.contains("is-open")) return true;

  if (!dataUrl) {
    msg.textContent =
      "The receipt photo for this sale is not available. It may have been removed, " +
      "or this sale was recorded before photographs were kept.";
    return true;
  }

  msg.classList.add("is-hidden");
  img.src = dataUrl;
  img.classList.remove("is-hidden");
  save.href = dataUrl;
  save.download = "receipt-" + row.dateKey + "-" + row.txnId + ".jpg";
  save.classList.remove("is-hidden");
  return true;
}

/* ---------------- Settle / delete ---------------- */

async function settleRow(row, closed) {
  const ok = await confirm({
    title: "Mark as paid",
    message:
      "Mark the " + formatINR(row.totalPaise) + " due for " + row.serviceName + " as paid?",
    confirmText: "Mark paid",
    variant: "primary",
  });
  if (!ok) return false;

  try {
    await assertDayOpen(row);
    await markTransactionPaid(row.txnId, row.dateKey);
    row.status = "paid";
    toast("Marked as paid.", "success");
    return true;
  } catch (err) {
    console.error("[trustx-ledger] settle:", err, row.dateKey, row.txnId);
    toast(await describeRefusedWrite(err, closed, row), "error");
    return false;
  }
}

async function deleteRow(row, closed) {
  const ok = await confirm({
    title: "Delete this sale?",
    message:
      "Delete " + row.quantity + " \u00D7 " + row.serviceName +
      " (" + formatINR(row.totalPaise) + ", " + row.methodLabel + ")? This cannot be undone.",
    confirmText: "Delete sale",
  });
  if (!ok) return false;

  try {
    await assertDayOpen(row);
    await deleteTransaction(row.txnId, row.dateKey);
    toast("Sale deleted.", "success");
    return true;
  } catch (err) {
    console.error("[trustx-ledger] delete:", err, row.dateKey, row.txnId);
    toast(await describeRefusedWrite(err, closed, row), "error");
    return false;
  }
}
