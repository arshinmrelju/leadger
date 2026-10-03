/* =========================================================
   TrustX Ledger — Month calendar (pure grid logic)
   -----------------------------------------------------------------
   The shop fills its ledger in the evening, before locking up. That
   means a sale can be filed against a business day that is not today,
   and it means the one question the shopkeeper actually has at the end
   of the month is: "which days are still missing?"

   This module answers that with no Firebase import at all, for the
   same reason js/day-ledger.js does: a calendar that is off by one
   weekday, or that calls a day with no sales "recorded", is a wrong
   thing to show a shopkeeper, and it should fail the test suite rather
   than the month's books.

   Everything here works on Asia/Kolkata `dateKey` strings
   (`YYYY-MM-DD`) and on day heads the caller already fetched:

     monthBounds("2026-09") -> { yearMonth, firstKey, lastKey, days }
     shiftMonth("2026-09", -1) -> "2026-08"
     buildGrid({ yearMonth, heads, todayKey }) -> 42 cells
     monthTotals(cells) -> { grossPaise, collectedPaise, duePaise, ... }
     missedDays(cells) -> ["2026-09-03", ...]

   A day with no head is not an error and not a zero-sales day: it is a
   day the shop never recorded. `buildGrid` says so with
   `status: "empty"` and `monthTotals` counts those days separately
   from days that genuinely sold nothing.
   ========================================================= */

import { isValidDateKey, todayKolkata } from "./utils.js";
import { daysBetweenDateKeys } from "./day-ledger.js";

const MS_PER_DAY = 86400000;

/** How a day in the grid presents itself. */
export const DAY_STATUS = Object.freeze({
  /** Sales recorded, day still open. */
  FILLED: "filled",
  /** Sales recorded and the day has been closed. */
  CLOSED: "closed",
  /** No sales and no day head: nothing was ever recorded. */
  EMPTY: "empty",
  /** After today, so nothing can be recorded on it yet. */
  FUTURE: "future",
});

/** Monday-first, because that is how an Indian shop calendar is read. */
export const WEEKDAY_LABELS = Object.freeze(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  month: "long",
  year: "numeric",
});

const YEAR_MONTH_REGEX = /^\d{4}-\d{2}$/;

/**
 * Parse `YYYY-MM-DD` into a UTC-noon Date.
 *
 * Noon, never midnight: this file only ever does calendar arithmetic
 * on the result, and a UTC-noon anchor cannot be pushed into a
 * neighbouring day or month by the viewer's own timezone or a DST
 * boundary. Nothing here is formatted in local time — the labels go
 * through Intl with Asia/Kolkata pinned.
 */
function dateKeyToUTC(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** UTC-noon Date -> `YYYY-MM-DD`. */
function utcToDateKey(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** The current month in Asia/Kolkata, as a `YYYY-MM` string. */
export function currentYearMonth(todayKey = null) {
  /* Asked for a month later than the one it is in, a caller in any other
     timezone can disagree with the shop's books by a whole month at the
     turn of the month, so the default goes through Kolkata's own date
     rather than the browser's. */
  const key = todayKey && isValidDateKey(todayKey) ? todayKey : todayKolkata();
  const base = dateKeyToUTC(key);
  return `${base.getUTCFullYear()}-${pad2(base.getUTCMonth() + 1)}`;
}

/**
 * Shift a month by whole months, without a Date in the middle.
 *
 * Built on the first of the month so a shift can never land on the
 * 30th of a short month, and clamped back when it does: 31 Jan + 1
 * month is 28/29 Feb, not 3 March.
 *
 * @param {string} yearMonth  `YYYY-MM`
 * @param {number} months     whole months, may be negative
 * @returns {string|null} `YYYY-MM`, or null when the input is not a month
 */
export function shiftMonth(yearMonth, months = 0) {
  if (typeof yearMonth !== "string" || !YEAR_MONTH_REGEX.test(yearMonth)) return null;
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(5, 7));
  if (month < 1 || month > 12) return null;

  /* Month 0 is December of the year before, so +/- maths is plain. */
  const shifted = new Date(Date.UTC(year, month - 1 + Math.trunc(Number(months) || 0), 1, 12, 0, 0));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}`;
}

/**
 * The two `dateKey`s that bracket a month, and how many days it holds.
 *
 * `firstKey` / `lastKey` are what the month read asks Firestore for, so
 * they are strings rather than Dates on purpose: the range query is
 * over a `dateKey` field, and building the same bound twice (once for
 * the query, once for the grid) from one source is what keeps them
 * from disagreeing at a month boundary.
 *
 * @param {string} yearMonth  `YYYY-MM`
 * @returns {{yearMonth: string, firstKey: string, lastKey: string, days: number}|null}
 */
export function monthBounds(yearMonth) {
  if (typeof yearMonth !== "string" || !YEAR_MONTH_REGEX.test(yearMonth)) return null;
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(5, 7));
  if (month < 1 || month > 12) return null;

  const firstKey = `${yearMonth}-01`;
  const daysInMonth = new Date(Date.UTC(year, month, 0, 12, 0, 0)).getUTCDate();
  const lastKey = `${yearMonth}-${pad2(daysInMonth)}`;
  return { yearMonth, firstKey, lastKey, days: daysInMonth };
}

/** Heading label for a month, e.g. `September 2026`. */
export function monthLabel(yearMonth) {
  if (typeof yearMonth !== "string" || !YEAR_MONTH_REGEX.test(yearMonth)) return "";
  const [y, m] = yearMonth.split("-").map(Number);
  if (m < 1 || m > 12) return "";
  /* UTC-noon on the 15th: day-of-month cannot drag the label into a
     neighbouring month whatever the viewer's timezone is. */
  return MONTH_LABEL.format(new Date(Date.UTC(y, m - 1, 15, 12, 0, 0)));
}

/** Short label for a day cell, e.g. `12 Sept`. */
export function dayCellLabel(dateKey) {
  if (!isValidDateKey(dateKey)) return "";
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
  }).format(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)));
}

/**
 * The 6-week grid a month is drawn into, Monday first.
 *
 * Always whole weeks: a 42-cell grid with the trailing days greyed keeps
 * every month the same height, so the page does not jump between
 * February and a 31-day month. (Six weeks is always enough — the
 * longest possible month needs at most six.)
 *
 * The leading cells belong to the previous month and the trailing ones
 * to the next; they are returned with `inMonth: false` so the page can
 * draw them faint, and they carry no head figures even when the caller
 * happened to fetch them.
 *
 * @param {object} opts
 * @param {string} opts.yearMonth   `YYYY-MM` to draw
 * @param {object} [opts.heads]     dateKey -> { txnCount, grossPaise, collectedPaise, duePaise, closed }
 * @param {string} [opts.todayKey]  today's dateKey, Asia/Kolkata
 * @returns {Array<object>} 42 cells, in reading order
 */
export function buildGrid({ yearMonth, heads = null, todayKey = "" } = {}) {
  const bounds = monthBounds(yearMonth);
  if (!bounds) return [];

  const table = heads && typeof heads === "object" ? heads : {};
  const today = isValidDateKey(todayKey) ? todayKey : "";
  const gridStart = shiftDateKeyLocal(bounds.firstKey, -weekdayIndex(bounds.firstKey));

  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const dateKey = shiftDateKeyLocal(gridStart, i);
    const inMonth = dateKey.slice(0, 7) === bounds.yearMonth;
    const isToday = today ? dateKey === today : false;

    /* A future day is not "missing" even though it has no head, so the
       status is decided before the head is consulted and the caller
       never has to remember to special-case next week. Positive means
       the cell is AFTER today. */
    if (today && daysBetweenDateKeys(today, dateKey) > 0) {
      cells.push(blankCell(dateKey, inMonth, true, isToday));
      continue;
    }

    const head = inMonth ? readHead(table[dateKey]) : null;

    if (!head) {
      cells.push(blankCell(dateKey, inMonth, false, isToday));
      continue;
    }
    cells.push({
      dateKey,
      inMonth,
      isToday,
      isFuture: false,
      status: head.closed ? DAY_STATUS.CLOSED : DAY_STATUS.FILLED,
      txnCount: head.txnCount,
      grossPaise: head.grossPaise,
      collectedPaise: head.collectedPaise,
      duePaise: head.duePaise,
      closed: head.closed,
    });
  }
  return cells;
}

/** Monday = 0 … Sunday = 6, from the `dateKey` itself. */
function weekdayIndex(dateKey) {
  const day = dateKeyToUTC(dateKey).getUTCDay(); // Sunday = 0
  return (day + 6) % 7;
}

/**
 * Local day shift. Named apart from `shiftDateKey` in js/day-ledger.js
 * only to keep this file free of that import's page-level concerns; the
 * arithmetic is deliberately identical, because there is exactly one
 * correct way to step a date key and two copies of it would drift.
 */
function shiftDateKeyLocal(key, days) {
  const shifted = new Date(dateKeyToUTC(key).getTime() + Math.trunc(Number(days) || 0) * MS_PER_DAY);
  return utcToDateKey(shifted);
}

function blankCell(dateKey, inMonth, isFuture, isToday) {
  return {
    dateKey,
    inMonth,
    isToday,
    isFuture,
    status: isFuture ? DAY_STATUS.FUTURE : DAY_STATUS.EMPTY,
    txnCount: 0,
    grossPaise: 0,
    collectedPaise: 0,
    duePaise: 0,
    closed: false,
  };
}

/**
 * Normalise one stored day head into what a cell needs.
 *
 * Deliberately paranoid: a head whose counters do not add up is a head
 * the rules should have refused, but a shopkeeper must never be shown a
 * confident ₹ figure derived from it. An unusable head reads as "no
 * sales", which is the honest reading of a day this app cannot account
 * for — and the month's totals then leave it out rather than inventing
 * one.
 *
 * @param {object} head  a stored head document (or an already-flat row)
 * @returns {object|null} null when there is nothing usable to draw
 */
function readHead(head) {
  if (!head || typeof head !== "object") return null;

  const counters = head.counters && typeof head.counters === "object" ? head.counters : head;
  const txnCount = toCount(counters.txnCount);
  const grossPaise = toCount(counters.grossPaise);
  const collectedPaise = toCount(counters.collectedPaise);
  const duePaise = toCount(counters.duePaise);
  if (txnCount === null || grossPaise === null || collectedPaise === null || duePaise === null) return null;

  /* The same invariant firestore.rules holds a head to: what was
     collected is the gross minus what is still outstanding. */
  if (collectedPaise !== grossPaise - duePaise) return null;

  return {
    txnCount,
    grossPaise,
    collectedPaise,
    duePaise,
    closed: head.state === "closed" || head.closed === true,
  };
}

function toCount(value) {
  if (value === undefined || value === null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Month totals, from the cells `buildGrid` returned.
 *
 * Only in-month days are counted: the grey leading and trailing cells
 * belong to the months either side and would quietly inflate this.
 * `daysMissed` is the answer the calendar exists to give — past days in
 * this month with nothing recorded against them.
 */
export function monthTotals(cells) {
  const totals = {
    grossPaise: 0,
    collectedPaise: 0,
    duePaise: 0,
    txnCount: 0,
    daysInMonth: 0,
    daysRecorded: 0,
    daysClosed: 0,
    daysMissed: 0,
  };

  for (const cell of Array.isArray(cells) ? cells : []) {
    if (!cell || !cell.inMonth || cell.isFuture) continue;
    totals.daysInMonth += 1;
    if (cell.status === DAY_STATUS.FILLED || cell.status === DAY_STATUS.CLOSED) {
      totals.daysRecorded += 1;
      totals.grossPaise += toCount(cell.grossPaise) || 0;
      totals.collectedPaise += toCount(cell.collectedPaise) || 0;
      totals.duePaise += toCount(cell.duePaise) || 0;
      totals.txnCount += toCount(cell.txnCount) || 0;
    } else {
      totals.daysMissed += 1;
    }
    if (cell.status === DAY_STATUS.CLOSED) totals.daysClosed += 1;
  }
  return totals;
}

/**
 * Past days of the month with nothing recorded, oldest first.
 *
 * Capped, because the answer to "which days did I miss?" is useless if
 * it is a wall of thirty dates: the page shows the first few and
 * counts the rest.
 *
 * @param {Array<object>} cells
 * @param {number} [limit]
 */
export function missedDays(cells, limit = 10) {
  const list = [];
  for (const cell of Array.isArray(cells) ? cells : []) {
    if (!cell || !cell.inMonth) continue;
    if (cell.status !== DAY_STATUS.EMPTY) continue;
    list.push(cell.dateKey);
  }
  return list.slice(0, Math.max(0, Math.trunc(Number(limit) || 0)));
}

/**
 * Read a `dateKey` out of a page's URL.
 *
 * `ledger.html?date=2026-09-03` is how the calendar hands a day to the
 * daily ledger, so every date-scoped page takes the same hint. An
 * unusable value is ignored rather than obeyed — a hand-edited or stale
 * link must not be able to park a page on a day that does not exist.
 *
 * @param {string} [search]  `location.search`; defaults to the real one
 * @returns {string|null} a valid `dateKey`, or null
 */
export function dateKeyFromSearch(search = null) {
  const query =
    search === null || search === undefined
      ? (typeof window !== "undefined" && window.location ? window.location.search : "")
      : String(search);
  if (!query) return null;

  let key = null;
  try {
    key = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query).get("date");
  } catch {
    return null;
  }
  if (!key) return null;
  const clean = String(key).trim();
  return isValidDateKey(clean) ? clean : null;
}

/**
 * Replace the current URL's `date` hint without adding a history entry.
 *
 * `null` clears the hint rather than leaving it behind: a page that has
 * been switched back to all-time has no day to be pinned to, and a stale
 * `?date=` would put the next reload (or the Back button) on a day the
 * shopkeeper has already moved off.
 *
 * An unusable key is ignored rather than obeyed, matching the read side.
 *
 * @param {string|null} dateKey  a `dateKey`, or null to clear
 */
export function writeDateToSearch(dateKey) {
  if (typeof window === "undefined" || !window.history || !window.location) return;
  const url = new URL(window.location.href);
  if (dateKey === null || dateKey === undefined || dateKey === "") {
    url.searchParams.delete("date");
  } else {
    if (!isValidDateKey(dateKey)) return;
    url.searchParams.set("date", dateKey);
  }
  window.history.replaceState(null, "", url.toString());
}