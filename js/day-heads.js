/* =========================================================
   TrustX Ledger — Day head: the pure shape of a business day
   -----------------------------------------------------------------
   One business day is one document. It owns when it opened, whether it
   is still open, and the running totals the dashboard reads instead of
   re-reading every sale. This module is the Firebase-free half of that:
   the counter set, the per-method split of a sale, and the invariant
   the security rules re-check on every write.

   It is deliberately separate from js/ledger.js — the data layer — for
   the same reason js/day-ledger.js is: this file imports nothing from
   Firebase, so the money arithmetic the RULES depend on is unit
   testable in bare Node, and a regression here fails the test suite
   rather than a shop's totals.
   ========================================================= */

/** The only two states a day can be in. */
export const DAY_STATE = Object.freeze({
  OPEN: "open",
  CLOSED: "closed",
});

/** The only payment methods a sale can be split across. */
export const PAYMENT_METHODS = Object.freeze(["cash", "upi", "card", "due"]);

/**
 * The counter set on a day head, in the exact shape firestore.rules
 * pins with `keys().hasOnly(...)`. The name list and the field list
 * below must not drift apart: the rules reject any head that carries a
 * field not named here.
 */
export const COUNTER_FIELDS = Object.freeze([
  "txnCount",
  "grossPaise",
  "cashPaise",
  "upiPaise",
  "cardPaise",
  "duePaise",
  "collectedPaise",
]);

/** Mirrors the rules' field ranges, so a bad value is caught locally. */
const MAX_COUNTER_VALUE = 100000000000000; // a whole day of max-value sales

/** A brand new day: open, nothing sold. */
export function emptyCounters() {
  return {
    txnCount: 0,
    grossPaise: 0,
    cashPaise: 0,
    upiPaise: 0,
    cardPaise: 0,
    duePaise: 0,
    collectedPaise: 0,
  };
}

/** Coerce a stored counter field to a safe non-negative integer. */
function toCounterInt(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

/**
 * Split a sale's total across the four payment buckets.
 *
 * This is the map a sale is written with, and it is what the day's
 * counters are advanced by. The rules re-check two things about it:
 * that the buckets add up to the total, and that the single non-zero
 * bucket is the sale's actual payment method. So a client that lies
 * here cannot move a day counter by an amount the sale does not account
 * for.
 *
 * @param {number} totalPaise    the sale's total, integer paise
 * @param {string} paymentMethod  one of PAYMENT_METHODS
 * @throws {Error} on an unknown method — a sale must never silently
 *   contribute nothing to the day it was recorded on.
 */
export function splitAmounts(totalPaise, paymentMethod) {
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    throw new Error("Split a sale across an unknown payment method.");
  }
  const gross = toCounterInt(totalPaise);
  return {
    gross,
    cash: paymentMethod === "cash" ? gross : 0,
    upi: paymentMethod === "upi" ? gross : 0,
    card: paymentMethod === "card" ? gross : 0,
    due: paymentMethod === "due" ? gross : 0,
    collected: paymentMethod === "due" ? 0 : gross,
  };
}

/**
 * Read a stored `amounts` map back defensively, falling back to
 * splitting the row's own total when a document predates the split.
 * Mirrors what js/ledger.js does when it has to edit or delete a sale
 * whose day head still has to be kept in step.
 *
 * The fallback uses the document's OWN payment method. A caller can
 * override it, but the default matters: filing a legacy sale under the
 * wrong bucket would move the day by a real amount on the wrong side.
 *
 * @param {object} doc  a stored transaction document
 * @param {string} [fallbackMethod]  overrides the document's method
 */
export function amountsFromDoc(doc, fallbackMethod = null) {
  const a = doc && doc.amounts;
  if (a && a.gross !== undefined) {
    return {
      gross: toCounterInt(a.gross),
      cash: toCounterInt(a.cash),
      upi: toCounterInt(a.upi),
      card: toCounterInt(a.card),
      due: toCounterInt(a.due),
      collected: toCounterInt(a.collected),
    };
  }
  /* An unreadable method must not stop a shopkeeper fixing a bad row, so
     it falls back to cash rather than throwing on the way out. */
  const own = doc ? doc.paymentMethod : null;
  const method = fallbackMethod || (PAYMENT_METHODS.includes(own) ? own : "cash");
  return splitAmounts(toCounterInt(doc ? doc.total : 0), method);
}

/**
 * The invariant firestore.rules re-checks on every head write: nothing
 * negative, the four payment buckets add up to the gross, and what has
 * been collected is the gross minus what is still outstanding.
 *
 * The client runs it on a head it has just read, so a counter set that
 * cannot be trusted (a half-written offline document, a future schema
 * change) is never used to show the shop a day's takings.
 *
 * @param {object} c  a counter set
 * @returns {boolean}
 */
export function isCounterSetValid(c) {
  if (!c || typeof c !== "object") return false;

  const keys = Object.keys(c);
  if (keys.length !== COUNTER_FIELDS.length) return false;
  for (const field of COUNTER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(c, field)) return false;
  }

  for (const field of COUNTER_FIELDS) {
    const v = c[field];
    if (typeof v !== "number" || !Number.isInteger(v)) return false;
    if (v < 0) return false;
    if (v > MAX_COUNTER_VALUE) return false;
  }

  if (c.grossPaise !== c.cashPaise + c.upiPaise + c.cardPaise + c.duePaise) return false;
  if (c.collectedPaise !== c.grossPaise - c.duePaise) return false;
  return true;
}

/**
 * Apply one sale's contribution to a day's counters, in the sale's
 * direction. This is the client-side twin of the rules' headSteppedBy:
 * the rules prove the batch moved the head by exactly this, and this
 * keeps a locally-held copy consistent so an offline day still totals
 * correctly before it syncs.
 *
 * @param {object} counters   the day's current counters
 * @param {object} amounts    a split from splitAmounts()
 * @param {number} [step]     +1 to add a sale, -1 to remove one
 * @returns {object} a new counter set (the input is not mutated)
 */
export function stepCounters(counters, amounts, step = 1) {
  return {
    txnCount: toCounterInt(counters.txnCount) + step,
    grossPaise: toCounterInt(counters.grossPaise) + amounts.gross * step,
    cashPaise: toCounterInt(counters.cashPaise) + amounts.cash * step,
    upiPaise: toCounterInt(counters.upiPaise) + amounts.upi * step,
    cardPaise: toCounterInt(counters.cardPaise) + amounts.card * step,
    duePaise: toCounterInt(counters.duePaise) + amounts.due * step,
    collectedPaise: toCounterInt(counters.collectedPaise) + amounts.collected * step,
  };
}
