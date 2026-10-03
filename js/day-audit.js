/* =========================================================
   TrustX Ledger — day-integrity check
   ------------------------------------------------------------
   READ-ONLY. Adds up a business day's sales and compares the
   total with the counters sitting on that day's head.

   Why it exists: firestore.rules only ever lets a sale move a
   day head by exactly one sale's worth, in that sale's own
   direction. A sale can therefore be added to a day whose head
   is already correct, but it can be DELETED only while the head
   still carries that sale's money. Once a head stops agreeing
   with its sales — a sale removed straight from the Firestore
   console moves no counters — nothing on that day can be
   edited, settled or deleted again, and the app has nothing but
   a bare permission-denied to show for it.

   The sum below uses the same derivation the write path and the
   rules both use (amountsFromDoc, stepCounters), so its verdict
   is the very arithmetic being refused. No network here: the
   caller hands over the head and the day's rows.
   ========================================================= */

import {
  COUNTER_FIELDS,
  amountsFromDoc,
  emptyCounters,
  isCounterSetValid,
  stepCounters,
} from "./day-heads.js";

/**
 * What a check found. Kept small so a caller can switch on it;
 * the order they are tested in is the order of severity.
 */
export const AUDIT_STATUS = Object.freeze({
  /** Head matches the day's sales exactly. */
  OK: "ok",
  /** No head at all for a day that has sales (or none either). */
  NO_HEAD: "no-head",
  /** The head's own counters break the invariant the rules enforce. */
  BAD_HEAD: "bad-head",
  /** At least one sale document the rules cannot read at all. */
  UNREADABLE: "unreadable",
  /** Too many sales to read in one query, so no verdict is possible. */
  INCOMPLETE: "incomplete",
  /** Head is valid but does not add up to the day's sales. */
  DRIFTED: "drifted",
});

/**
 * How each counter is named in a report. `money` is false for the
 * sale count, which is a number of sales rather than a sum in
 * paise. The `field` list must stay identical to COUNTER_FIELDS —
 * tests/ledger.mjs asserts it, because a name added to one and not
 * the other would silently drop a column from every report.
 */
export const AUDIT_FIELDS = Object.freeze([
  { field: "txnCount", label: "Sales", money: false },
  { field: "grossPaise", label: "Gross", money: true },
  { field: "cashPaise", label: "Cash", money: true },
  { field: "upiPaise", label: "UPI", money: true },
  { field: "cardPaise", label: "Card", money: true },
  { field: "duePaise", label: "Due", money: true },
  { field: "collectedPaise", label: "Collected", money: true },
]);

/** Coerce a stored value to a safe integer, the way the counters do. */
function asInt(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

/**
 * Does this sale document carry the per-method amounts map?
 *
 * firestore.rules reads `resource.data.amounts.gross` on every edit,
 * settle and delete of a sale. A document without that field does not
 * fail the check, it ERRORS the evaluation, and the whole write is
 * refused. Such a row can therefore never be deleted however healthy
 * the head is — while the client can still read it, because
 * amountsFromDoc falls back to the row's own total and method. That
 * gap between the two readings is exactly the sort of thing this
 * check exists to name.
 */
function hasAmountsMap(doc) {
  const a = doc ? doc.amounts : null;
  return !!(a && typeof a === "object" && a.gross !== undefined);
}

/**
 * Add up a day's sales into the counter set the head should be
 * carrying. A row the rules cannot read is reported rather than
 * guessed at: guessing would put a number in the report that no
 * rule would ever agree with.
 *
 * @param {object[]} rows  stored sale documents for one business day
 * @returns {{counters: object, saleCount: number, unreadable: string[]}}
 */
export function sumDayCounters(rows) {
  let counters = emptyCounters();
  const unreadable = [];
  let saleCount = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    saleCount += 1;

    if (!hasAmountsMap(row)) {
      unreadable.push(String(row.txnId || "(unnamed)"));
      continue;
    }
    counters = stepCounters(counters, amountsFromDoc(row));
  }

  return { counters, saleCount, unreadable };
}

/**
 * Compare a day's head with the day's sales.
 *
 * `head` is the day head document as stored (`{ state, counters }`)
 * or null when there is none. A day with sales but no head is still
 * compared — against the zeros a head is created with — so the report
 * shows what is unaccounted for instead of only "no head".
 *
 * @param {object} opts
 * @param {string} [opts.dateKey]     Asia/Kolkata `YYYY-MM-DD`
 * @param {object|null} [opts.head]   the stored day head, or null
 * @param {object[]} [opts.rows]      stored sale documents for the day
 * @param {boolean} [opts.truncated]  the read stopped at its limit
 * @returns {object} the audit report
 */
export function auditDayCounters({ dateKey = "", head = null, rows = [], truncated = false } = {}) {
  const sum = sumDayCounters(rows);
  const stored =
    head && typeof head === "object" && head.counters && typeof head.counters === "object"
      ? head.counters
      : null;

  const baseline = {};
  for (const field of COUNTER_FIELDS) baseline[field] = stored ? asInt(stored[field]) : 0;

  /* Only fields that disagree are reported: seven rows of "0 = 0"
     would bury the one number the shopkeeper needs. */
  const drift = AUDIT_FIELDS.map(({ field, label, money }) => ({
    field,
    label,
    money,
    head: baseline[field],
    actual: sum.counters[field],
    delta: sum.counters[field] - baseline[field],
  })).filter((d) => d.delta !== 0);

  let status = AUDIT_STATUS.OK;
  if (!stored) {
    status = AUDIT_STATUS.NO_HEAD;
  } else if (!isCounterSetValid(stored)) {
    status = AUDIT_STATUS.BAD_HEAD;
  } else if (sum.unreadable.length) {
    status = AUDIT_STATUS.UNREADABLE;
  } else if (truncated) {
    /* A partial sum is not a small difference, it is no answer. */
    status = AUDIT_STATUS.INCOMPLETE;
  } else if (drift.length) {
    status = AUDIT_STATUS.DRIFTED;
  }

  return {
    dateKey: String(dateKey || ""),
    status,
    ok: status === AUDIT_STATUS.OK,
    state: stored && typeof head.state === "string" ? head.state : "",
    saleCount: sum.saleCount,
    unreadable: sum.unreadable,
    truncated: !!truncated,
    headCounters: stored,
    actualCounters: sum.counters,
    drift,
  };
}

/**
 * Turn a report into a headline, a tone and a sentence. Money is left
 * to the caller: the rupee figures live in `drift`, where they can be
 * rendered as a table instead of squeezed into a sentence.
 *
 * @param {object} audit  a report from auditDayCounters()
 * @returns {{tone: string, headline: string, detail: string}}
 */
export function describeAudit(audit) {
  const a = audit && typeof audit === "object" ? audit : auditDayCounters();
  const day = a.dateKey || "this day";
  const sales = a.saleCount === 1 ? "1 sale" : a.saleCount + " sales";

  switch (a.status) {
    case AUDIT_STATUS.OK:
      return {
        tone: "ok",
        headline: day + " is in step.",
        detail:
          "The day head adds up to its " + sales +
          " exactly, so sales on this day can be edited, settled and deleted.",
      };

    case AUDIT_STATUS.NO_HEAD:
      return {
        tone: "error",
        headline: "No day head for " + day + ".",
        detail: a.saleCount
          ? "This day holds " + sales + " but no day head at all. Every write to it is refused, a delete included."
          : "This day was never opened, so there is nothing to check.",
      };

    case AUDIT_STATUS.BAD_HEAD:
      return {
        tone: "error",
        headline: "The day head for " + day + " is not a valid counter set.",
        detail:
          "Its own counters break the rules' invariant (nothing negative, the four payment buckets add up " +
          "to the gross, and collected is the gross minus what is still due). Every write to this day is " +
          "refused, a delete included.",
      };

    case AUDIT_STATUS.UNREADABLE:
      return {
        tone: "error",
        headline:
          a.unreadable.length === 1
            ? "A sale on " + day + " cannot be read by the rules."
            : a.unreadable.length + " sales on " + day + " cannot be read by the rules.",
        detail:
          "They carry no per-method amounts map, so firestore.rules errors when it reads one and refuses " +
          "to delete or edit it, however healthy the head is: " + a.unreadable.join(", ") +
          ". This check cannot tell you what they are worth.",
      };

    case AUDIT_STATUS.INCOMPLETE:
      return {
        tone: "warning",
        headline: "Not every sale on " + day + " could be read.",
        detail:
          "The day holds more sales than one query returns, so this check says nothing about whether the " +
          "head is in step. Nothing is wrong here — the day is simply too big to check in one go.",
      };

    case AUDIT_STATUS.DRIFTED:
    default:
      return {
        tone: "error",
        headline: "The day head for " + day + " is out of step with its sales.",
        detail:
          "The head and the day's sales disagree on " +
          a.drift.map((d) => d.label.toLowerCase()).join(", ") +
          ". Sales can still be added to this day, but none of them can be edited, settled or deleted until " +
          "the head is put back in step.",
      };
  }
}