/* =========================================================
   SEVA LEDGER — Ledger data layer
   -----------------------------------------------------------------
   Flat single-shop collections:
     transactions/{txnId}   sales recorded on a business day
     services/{serviceId}   quick-service catalog
     expenses/{expId}       spends recorded on a business day
   All money is integer paise. Dates are Asia/Kolkata `YYYY-MM-DD`.
   Reads only touch TODAY's rows — never the whole store.
   ========================================================= */

import { getFirebridge } from "./firebase.js";
import {
  todayKolkata,
  uid,
  sanitizeQuantity,
  rateToPaise,
  computeTotalPaise,
  isPaymentMethod,
  methodLabel,
} from "./utils.js";

function toSafe(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toPaiseInt(value) {
  return Math.max(0, Math.round(toSafe(value)));
}

/* ------------------------------------------------------------------
   Normalizers — one trusted shape for the UI.
   The single-method transaction model (Part 4) is primary; legacy
   docs written with the old split-field shape are mapped defensively.
   ------------------------------------------------------------------ */

function normalizeTxn(id, raw) {
  const totalPaise = toPaiseInt(raw.total ?? raw.amountPaise);

  let paymentMethod;
  if (isPaymentMethod(raw.paymentMethod)) {
    paymentMethod = raw.paymentMethod;
  } else {
    paymentMethod = toPaiseInt(raw.cashPaise) > 0
      ? "cash"
      : toPaiseInt(raw.upiPaise) > 0
        ? "upi"
        : toPaiseInt(raw.cardPaise) > 0
          ? "card"
          : toPaiseInt(raw.duePaise) > 0
            ? "due"
            : "cash";
  }

  const isDue = paymentMethod === "due";
  const collectedPaise = isDue ? 0 : totalPaise;
  const duePaise = isDue ? totalPaise : 0;

  let status;
  if (raw.status === "paid" || raw.status === "pending") status = raw.status;
  else status = isDue ? "pending" : raw.status === "DUE" || raw.status === "PARTIAL" ? "pending" : "paid";

  let serviceName = String(raw.serviceName || "").trim();
  if (!serviceName) {
    const items = Array.isArray(raw.items) && raw.items.length ? raw.items : [];
    serviceName = items.slice(0, 1).map((i) => i.name || "Service").join(", ") || String(raw.service || raw.title || "Service");
  }

  return {
    txnId: id,
    ...raw,
    serviceName,
    serviceId: String(raw.serviceId || ""),
    quantity: toSafe(raw.quantity),
    ratePaise: toPaiseInt(raw.rate),
    totalPaise,
    paymentMethod,
    methodLabel: methodLabel(paymentMethod),
    collectedPaise,
    duePaise,
    status,
    customerId: String(raw.customerId || ""),
    customerName: String(raw.customerName || raw.customer || ""),
    customerPhone: String(raw.customerPhone || ""),
  };
}

function normalizeExpense(id, raw) {
  return {
    expId: id,
    ...raw,
    title: String(raw.title || raw.name || "Expense").trim(),
    amountPaise: toPaiseInt(raw.amountPaise),
  };
}

function normalizeService(id, raw) {
  return {
    serviceId: id,
    ...raw,
    name: String(raw.name || "").trim() || "Service",
    pricePaise: toPaiseInt(raw.pricePaise),
    active: raw.active !== false,
    sortOrder: toSafe(raw.sortOrder),
  };
}

function emptySummary() {
  return {
    transactions: [],
    count: 0,
    amountPaise: 0,
    paidPaise: 0,
    cashPaise: 0,
    upiPaise: 0,
    cardPaise: 0,
    duePaise: 0,
    expensesPaise: 0,
    netPaise: 0,
  };
}

/* ------------------------------------------------------------------
   Reads
   ------------------------------------------------------------------ */

/**
 * One-shot summary of a single business day (default: today in India).
 * Runs two server-first reads in parallel and aggregates client-side.
 * NET = today's collections (cash + UPI + card) − today's expenses.
 * Dues are money not yet received and are excluded from NET.
 */
export async function fetchTodaySummary(dateKey = todayKolkata()) {
  const b = await getFirebridge();
  const fs = b.firestore;

  const txnQuery = fs.query(
    fs.collection(b.db, "transactions"),
    fs.where("dateKey", "==", dateKey),
    fs.orderBy("createdAt", "desc")
  );
  const expenseQuery = fs.query(
    fs.collection(b.db, "expenses"),
    fs.where("date", "==", dateKey)
  );

  const [txnSnap, expenseSnap] = await Promise.all([
    fs.getDocs(txnQuery),
    fs.getDocs(expenseQuery),
  ]);

  const summary = emptySummary();
  summary.transactions = txnSnap.docs.map((d) => normalizeTxn(d.id, d.data()));
  summary.count = summary.transactions.length;

  for (const t of summary.transactions) {
    summary.amountPaise += t.totalPaise;
    summary.paidPaise += t.collectedPaise;
    summary.duePaise += t.duePaise;
    if (t.paymentMethod === "cash") summary.cashPaise += t.totalPaise;
    else if (t.paymentMethod === "upi") summary.upiPaise += t.totalPaise;
    else if (t.paymentMethod === "card") summary.cardPaise += t.totalPaise;
  }

  for (const d of expenseSnap.docs) {
    summary.expensesPaise += normalizeExpense(d.id, d.data()).amountPaise;
  }
  summary.netPaise = summary.paidPaise - summary.expensesPaise;

  return summary;
}

/** Best-effort read of the quick-service catalog, active first. */
export async function fetchServices({ includeInactive = false } = {}) {
  const b = await getFirebridge();
  const fs = b.firestore;
  const snap = await fs.getDocs(fs.collection(b.db, "services"));
  const list = snap.docs
    .map((d) => normalizeService(d.id, d.data()))
    .sort(
      (x, y) =>
        (x.active ? 0 : 1) - (y.active ? 0 : 1) ||
        x.sortOrder - y.sortOrder ||
        String(x.name).localeCompare(String(y.name))
    );
  return includeInactive ? list : list.filter((s) => s.active);
}

/* ------------------------------------------------------------------
   Writes
   ------------------------------------------------------------------ */

/**
 * Create a service on the fly for quick entry. Safe integer paise.
 * @returns {Promise<{serviceId, name, pricePaise}>}
 */
export async function createService({ name, price }) {
  const b = await getFirebridge();
  const fs = b.firestore;
  const cleanName = String(name || "").trim();
  const pricePaise = rateToPaise(price);
  if (!cleanName || cleanName.length > 80) {
    throw new Error("Service name must be 1–80 characters.");
  }
  if (pricePaise === null) {
    throw new Error("Enter a valid rate for the service.");
  }
  const user = b.auth.currentUser;
  const serviceId = uid("svc");
  const doc = {
    serviceId,
    name: cleanName,
    code: "",
    pricePaise,
    active: true,
    sortOrder: 0,
    createdAt: fs.serverTimestamp(),
    createdBy: user ? user.uid : "",
    updatedAt: fs.serverTimestamp(),
    updatedBy: user ? user.uid : "",
  };
  await fs.setDoc(fs.doc(b.db, "services", serviceId), doc);
  return { serviceId, name: cleanName, pricePaise };
}

/**
 * Create a transaction. All money math is validated client-side in
 * integer paise; the same constraints are re-enforced by the rules.
 * `rate` is always RUPEES per unit (user-entered) and is converted to
 * integer paise before writing.
 * @returns {Promise<{txnId, totalPaise, status}>}
 */
export async function createTransaction({
  serviceId,
  serviceName,
  quantity,
  rate,        // rupees per unit (user-entered)
  paymentMethod,
  customerName = "",
  dateKey = todayKolkata(),
}) {
  const b = await getFirebridge();
  const fs = b.firestore;
  const user = b.auth.currentUser;

  const qty = sanitizeQuantity(quantity);
  const ratePaise = rateToPaise(rate);
  const totalPaise = computeTotalPaise(qty, ratePaise);

  if (qty === null) throw new Error("Quantity must be a whole number greater than 0.");
  if (ratePaise === null) throw new Error("Enter a valid rate (₹0 or more).");
  if (totalPaise === null) throw new Error("The total is out of the allowed range.");
  if (!serviceId || !String(serviceName || "").trim()) {
    throw new Error("Choose a service to record the sale against.");
  }
  if (typeof serviceName !== "string" || serviceName.length > 80) {
    throw new Error("Service name is invalid.");
  }
  if (!isPaymentMethod(paymentMethod)) {
    throw new Error("Choose a payment method (cash, UPI, card or due).");
  }
  if (!user || !user.uid) throw new Error("You need to be signed in to record a sale.");

  const txnId = uid("txn");
  const doc = {
    txnId,
    serviceId,
    serviceName: serviceName.trim(),
    quantity: qty,
    rate: ratePaise,
    total: totalPaise,
    paymentMethod,
    customerId: "",
    customerName: String(customerName || "").trim().slice(0, 120),
    status: paymentMethod === "due" ? "pending" : "paid",
    dateKey,
    createdAt: fs.serverTimestamp(),
    updatedAt: fs.serverTimestamp(),
    createdBy: user.uid,
    updatedBy: user.uid,
  };

  await fs.setDoc(fs.doc(b.db, "transactions", txnId), doc);
  return { txnId, totalPaise, status: doc.status };
}

/**
 * Edit a service (Developer only — the rules enforce it). Pass only the
 * fields you want to change: `name`, `price` (rupees), `active`.
 */
export async function updateService(serviceId, { name, price, active } = {}) {
  const b = await getFirebridge();
  const fs = b.firestore;
  if (!serviceId) throw new Error("Missing service id.");
  const user = b.auth.currentUser;

  const patch = {};
  if (name !== undefined) {
    const clean = String(name).trim();
    if (!clean || clean.length > 80) throw new Error("Service name must be 1–80 characters.");
    patch.name = clean;
  }
  if (price !== undefined) {
    const pricePaise = rateToPaise(price);
    if (pricePaise === null) throw new Error("Enter a valid rate for the service.");
    patch.pricePaise = pricePaise;
  }
  if (active !== undefined) patch.active = active === true;
  if (!Object.keys(patch).length) return { serviceId };

  patch.updatedAt = fs.serverTimestamp();
  patch.updatedBy = user ? user.uid : "";
  await fs.updateDoc(fs.doc(b.db, "services", serviceId), patch);
  return { serviceId, ...patch };
}

/**
 * Read transactions for the all-data browser. With a `dateKey`, uses the
 * (dateKey, createdAt DESC) index; without one, reads the most recent
 * docs across all dates (orderBy createdAt DESC only).
 */
export async function fetchTransactions({ dateKey = null, limit = 200 } = {}) {
  const b = await getFirebridge();
  const fs = b.firestore;
  const base = fs.collection(b.db, "transactions");
  const q = dateKey
    ? fs.query(base, fs.where("dateKey", "==", dateKey), fs.orderBy("createdAt", "desc"), fs.limit(limit))
    : fs.query(base, fs.orderBy("createdAt", "desc"), fs.limit(limit));
  const snap = await fs.getDocs(q);
  return snap.docs.map((d) => normalizeTxn(d.id, d.data()));
}

/** Read expenses for the all-data browser. */
export async function fetchExpenses({ dateKey = null, limit = 200 } = {}) {
  const b = await getFirebridge();
  const fs = b.firestore;
  const base = fs.collection(b.db, "expenses");
  const q = dateKey
    ? fs.query(base, fs.where("date", "==", dateKey), fs.limit(limit))
    : fs.query(base, fs.orderBy("createdAt", "desc"), fs.limit(limit));
  const snap = await fs.getDocs(q);
  return snap.docs.map((d) => normalizeExpense(d.id, d.data()));
}

/**
 * Resolve once all locally queued writes have hit the server. Rejects
 * when the client is offline (nothing to wait on in that case).
 * Used for the "Changes synced" feedback after working offline.
 */
export async function flushPendingWrites() {
  const b = await getFirebridge();
  const fs = b.firestore;
  await fs.waitForPendingWrites(b.db);
  return true;
}

/** Coarse check: did this error come from being offline / no network? */
export function isNetworkError(err) {
  const code = err && err.code ? String(err.code) : "";
  if (
    code === "unavailable" ||
    /network|internet|offline|fetch|deadline-exceeded/i.test(code)
  ) {
    return true;
  }
  const msg = err && err.message ? String(err.message) : "";
  return /Failed to fetch|NetworkError|load failed|network error|offline/i.test(msg);
}