/* =========================================================
   TrustX Ledger — Daily ledger view logic
   -----------------------------------------------------------------
   Pure helpers for one business day. Deliberately free of any
   Firebase import so the filtering, totals and date arithmetic can
   be unit tested in Node (see tests/ledger.mjs).

   Every function here operates on a single Asia/Kolkata `dateKey`
   (`YYYY-MM-DD`) or on rows already fetched for that day. Nothing in
   this file talks to Firestore — the page fetches the day once, then
   narrows client-side so typing in the search box never issues a
   query.
   ========================================================= */

import { isValidDateKey, formatKolkataLong } from "./utils.js";

const MS_PER_DAY = 86400000;

/**
 * Parse `YYYY-MM-DD` into a UTC-noon Date.
 *
 * Noon rather than midnight: it keeps the arithmetic away from either
 * end of the day, so a +1 / -1 shift can never land in a neighbouring
 * month or be skipped by a DST boundary in the viewer's own timezone.
 * The date is only ever used for calendar maths, never formatted
 * locally — the user-facing label goes through `dayHeading()`.
 */
function dateKeyToUTC(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function utcToDateKey(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Shift a `dateKey` by whole days. `shiftDateKey(key, -1)` = yesterday. */
export function shiftDateKey(key, days) {
  if (!isValidDateKey(key)) return null;
  const n = Math.trunc(Number(days) || 0);
  const shifted = new Date(dateKeyToUTC(key).getTime() + n * MS_PER_DAY);
  return utcToDateKey(shifted);
}

/**
 * Heading label for a business day, e.g. `Saturday, 26 Sept 2026`.
 *
 * Delegates to the shared `formatKolkataLong` so the app keeps a single
 * spelling of a long date. The UTC-noon anchor matters because that
 * formatter reads the clock in Asia/Kolkata: noon UTC is 17:30 on the
 * same day there, so the weekday and day-of-month can never slip to a
 * neighbouring day.
 */
export function dayHeading(key) {
  if (!isValidDateKey(key)) return "";
  return formatKolkataLong(dateKeyToUTC(key));
}

/** Human label for the time a sale was recorded, in Asia/Kolkata. */
export function formatEntryTime(value) {
  if (!value) return "—";
  let date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value.toDate === "function") {
    // Firestore Timestamp.
    date = value.toDate();
  } else if (typeof value.seconds === "number") {
    date = new Date(value.seconds * 1000);
  } else {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "—";
    date = parsed;
  }
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function toInt(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

const PAYMENT_METHODS = ["cash", "upi", "card", "due"];
const STATUSES = ["paid", "pending"];

export function isFilterableMethod(value) {
  return PAYMENT_METHODS.includes(value);
}

export function isFilterableStatus(value) {
  return STATUSES.includes(value);
}

/**
 * Narrow a day's rows to the active search text, payment filter and
 * status filter. `any` disables a filter. Search is case-insensitive
 * across service, customer and the payment label.
 */
export function filterDayRows(rows, { query = "", method = "any", status = "any" } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const needle = String(query || "").trim().toLowerCase();
  const useMethod = isFilterableMethod(method) ? method : "any";
  const useStatus = isFilterableStatus(status) ? status : "any";

  return list.filter((row) => {
    if (!row) return false;
    if (useMethod !== "any" && row.paymentMethod !== useMethod) return false;
    if (useStatus !== "any" && row.status !== useStatus) return false;
    if (!needle) return true;

    const haystack = [row.serviceName, row.customerName, row.paymentMethod, row.status]
      .map((v) => String(v == null ? "" : v).toLowerCase())
      .join(" ");
    return haystack.includes(needle);
  });
}

/**
 * Day totals. `revenuePaise` is the gross booked value of every row
 * (paid and due alike); `duePaise` is the unpaid slice of it.
 */
export function dayTotals(rows) {
  const totals = {
    count: 0,
    revenuePaise: 0,
    cashPaise: 0,
    upiPaise: 0,
    cardPaise: 0,
    duePaise: 0,
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const total = toInt(row.totalPaise);
    totals.count += 1;
    totals.revenuePaise += total;

    switch (row.paymentMethod) {
      case "cash":
        totals.cashPaise += total;
        break;
      case "upi":
        totals.upiPaise += total;
        break;
      case "card":
        totals.cardPaise += total;
        break;
      case "due":
        totals.duePaise += total;
        break;
      default:
        break;
    }
  }

  return totals;
}

/** Append a freshly fetched page to the rows already held for the day. */
export function mergeDayPage(rows, pageRows) {
  const base = Array.isArray(rows) ? rows : [];
  const extra = Array.isArray(pageRows) ? pageRows : [];
  if (!extra.length) return base;
  const seen = new Set(base.map((r) => r && r.txnId).filter(Boolean));
  for (const row of extra) {
    if (row && row.txnId && seen.has(row.txnId)) continue;
    if (row) seen.add(row.txnId);
    base.push(row);
  }
  return base;
}

/** Sort newest first, without mutating the input. */
export function sortDayRows(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
    const at = timeValue(a && a.createdAt);
    const bt = timeValue(b && b.createdAt);
    if (bt !== at) return bt - at;
    return String((a && a.txnId) || "").localeCompare(String((b && b.txnId) || ""));
  });
}

function timeValue(value) {
  if (!value) return 0;
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}
