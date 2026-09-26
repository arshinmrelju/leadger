/* =========================================================
   TrustX Ledger — Pure shared utilities
   Money (integer paise), dates (Asia/Kolkata), strings.
   ========================================================= */

export const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- Money ---------- */

/**
 * Convert a user-entered rupee amount to integer paise.
 * Handles "10", "10.50", "₹10.5", "10,000" — rejects anything else.
 * @returns {number} paise (rounded), or NaN when invalid
 */
export function toPaise(value) {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "number") return Math.round(value * 100);
  const cleaned = String(value)
    .replace(/[₹,\s]/g, "")
    .trim();
  if (!cleaned || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return NaN;
  return Math.round(parseFloat(cleaned) * 100);
}

/**
 * Format integer paise as an INR string (e.g. 1050 -> "₹10.50", 500 -> "₹5").
 */
export function formatINR(paise) {
  const safe = Number.isFinite(paise) ? paise : 0;
  const rupees = safe / 100;
  const hasSubunit = Math.round(safe) % 100 !== 0;
  return (
    "₹" +
    new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: hasSubunit ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(rupees)
  );
}

/** Amount helper for inputs: paise -> "10.50" (no currency symbol). */
export function paiseToInput(paise) {
  const safe = Number.isFinite(paise) ? paise : 0;
  return (safe / 100).toFixed(2).replace(/\.00$/, "");
}

export const MAX_QUANTITY = 100000;
export const MAX_RATE_PAISE = 10000000;   // ₹1,00,000 per unit maximum
export const MAX_TOTAL_PAISE = 100000000000; // ₹1,00,00,00,000 per sale maximum

/**
 * Parse a quantity: must be a whole number >= 1 (and <= MAX_QUANTITY).
 * Rejects NaN, Infinity, negatives, decimals and empty input.
 * @returns {number|null} the integer, or null when invalid
 */
export function sanitizeQuantity(value) {
  if (typeof value === "string") value = value.trim();
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY) return null;
  return n;
}

/**
 * Parse a user-entered rate (rupees per unit) into integer paise.
 * Rejects negatives, NaN, Infinity, over-budget rates and junk input.
 * @returns {number|null} paise, or null when invalid
 */
export function rateToPaise(value) {
  const p = toPaise(value);
  if (!Number.isFinite(p)) return null;
  if (p < 0 || p > MAX_RATE_PAISE) return null;
  return p;
}

/**
 * quantity x rate with integer paise math. Returns null when either
 * input is invalid or the total overflows the safe budget.
 * @returns {number|null} total paise, or null when invalid
 */
export function computeTotalPaise(quantity, ratePaise) {
  if (typeof quantity !== "number" || !Number.isInteger(quantity)) return null;
  if (quantity < 1 || quantity > MAX_QUANTITY) return null;
  if (typeof ratePaise !== "number" || !Number.isFinite(ratePaise) || ratePaise < 0) return null;
  const total = quantity * ratePaise;
  if (!Number.isSafeInteger(total) || total > MAX_TOTAL_PAISE) return null;
  return total;
}

/* ---------- Payment methods ---------- */

export const PAY_METHODS = Object.freeze(["cash", "upi", "card", "due"]);

export function isPaymentMethod(value) {
  return typeof value === "string" && PAY_METHODS.includes(value);
}

/** For a method, the transaction status recorded on save. */
export function statusForMethod(method) {
  if (!isPaymentMethod(method)) return null;
  return method === "due" ? "pending" : "paid";
}

/** Display label for a payment method ("cash" -> "Cash"). */
export function methodLabel(method) {
  const map = { cash: "Cash", upi: "UPI", card: "Card", due: "Due" };
  return (typeof method === "string" && map[method]) || (typeof method === "string" ? method : "Paid");
}

/* ---------- Dates (Asia/Kolkata) ---------- */

const kolkataParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Date key (YYYY-MM-DD) for a given Date in the Asia/Kolkata timezone.
 * The app never derives database date keys from the user's local timezone.
 */
export function kolkataDateKey(date = new Date()) {
  const parts = {};
  for (const p of kolkataParts.formatToParts(date)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Today's date key in Asia/Kolkata. */
export function todayKolkata() {
  return kolkataDateKey(new Date());
}

/** "YYYY-MM-DD" -> "DD/MM/YYYY" for display. Falls back to the input. */
export function formatDateKey(dateKey) {
  if (typeof dateKey !== "string" || !DATE_KEY_REGEX.test(dateKey)) return dateKey || "—";
  const [, y, m, d] = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return `${d}/${m}/${y}`;
}

/** Long weekday display, e.g. "Thursday, 24 Sep 2026", in India timezone. */
export function formatKolkataLong(date = new Date()) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  return dtf.format(date);
}

/** Short time (e.g. "9:42 am") for a Date / Firestore Timestamp in Asia/Kolkata. */
export function formatKolkataTime(value) {
  const dt = value && typeof value.toDate === "function" ? value.toDate() : value;
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(dt)
    .toLowerCase();
}

export function isValidDateKey(key) {
  if (typeof key !== "string" || !DATE_KEY_REGEX.test(key)) return false;
  const [y, m, d] = key.split("-").map(Number);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/* ---------- Strings / misc ---------- */

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Collapse a value down to display text, guarding against objects/undefined. */
export function displayText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function debounce(fn, waitMs = 250) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, waitMs);
  };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function isValidEmail(value) {
  return typeof value === "string" && EMAIL_REGEX.test(value.trim());
}

/** Human-friendly slash-separated ID, e.g. uid("txn") -> "txn_20260924_ab12cd34". */
export function uid(prefix = "doc") {
  const rand = Math.random().toString(16).slice(2, 10);
  const t = Date.now().toString(36) + Math.floor(Math.random() * 0xfffff).toString(36);
  return `${prefix}_${t}_${rand}`;
}

/** Format a number with a group separator for the UI (e.g. quantities). */
export function formatNumber(value) {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en-IN").format(value);
}