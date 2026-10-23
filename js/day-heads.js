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

/* ------------------------------------------------------------------
   The bound the rules put on a day head's OWN write
   ------------------------------------------------------------------
   A head cannot see the sale that moved it, so firestore.rules
   never asks "did this head move by exactly this sale?" — that is
   `headSteppedBy`, and it is checked on the SALE. The head's own
   update rule (`boundedCounterStep`) only asks whether the change is
   small enough to be a sale-sized move at all: a sale count that
   shifts by no more than one, money that moves by no more than
   HEAD_MONEY_STEP per field, and an after-set that still satisfies
   the invariant.

   Mirrored here rather than hard-coded at each call site, because
   the app has to be able to answer "will the rules accept this
   write?" BEFORE spending it — a refusal is otherwise
   indistinguishable from a drifted day. tests/ledger.mjs reads
   firestore.rules and asserts these two constants still match
   `boundedCounterStep`, so the two cannot drift apart silently.
   ------------------------------------------------------------------ */

/** Most a head's sale count may move in one accepted write. */
export const HEAD_COUNT_STEP = 1;

/** Most any one money counter may move, in paise, in one write. */
export const HEAD_MONEY_STEP = 100000000000;

/**
 * Would firestore.rules accept a head update from `before` to
 * `after`? The exact mirror of `boundedCounterStep`, deliberately
 * including what it does NOT check: nothing is said about `before`.
 * That is the whole reason a wrong head can be put right — the rule
 * judges the destination, not the journey.
 *
 * @param {object} before  the counters as stored
 * @param {object} after   the counters the write would leave behind
 * @returns {boolean}
 */
export function counterStepAllowed(before, after) {
  if (!isCounterSetValid(after)) return false;
  if (!before || typeof before !== "object") return false;

  const countDelta = toCounterInt(after.txnCount) - toCounterInt(before.txnCount);
  if (countDelta > HEAD_COUNT_STEP || countDelta < -HEAD_COUNT_STEP) return false;

  for (const field of COUNTER_FIELDS) {
    if (field === "txnCount") continue;
    const moved = toCounterInt(after[field]) - toCounterInt(before[field]);
    if (moved > HEAD_MONEY_STEP || moved < -HEAD_MONEY_STEP) return false;
  }

  return true;
}

/* ------------------------------------------------------------------
   Leave days — the pure shape of "the shop is shut today"
   ------------------------------------------------------------------
   A leave day has no head and no counters: it is only the FACT that the
   owner declared the day off, stored as the existence of
   dayLeaves/{dateKey}. This half mirrors the rules' validLeaveDoc so the
   client can answer "will the rules accept this mark?" BEFORE spending
   the write, exactly as counterStepAllowed does for a head.

   It carries no money and no arithmetic, but it belongs here rather than
   in the data layer for the same reason the other shapes do: the rules
   pin it with keys().hasOnly(), and a rule that drifts from the client
   is a refusal nobody can explain. tests/ledger.mjs reads
   firestore.rules and asserts the two still agree.
   ------------------------------------------------------------------ */

/** The only fields a leave document may carry. Mirrors the rules. */
export const LEAVE_DOC_FIELDS = Object.freeze(["dateKey", "markedAt", "markedBy"]);

/** A leave dateKey is an ordinary business day, pinned to its path. */
const LEAVE_DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Would firestore.rules accept this leave document on this path?
 *
 * The dateKey is checked against the PATH it is being written to, not
 * merely against the regex: a mark for one day filed under another day's
 * id is exactly the drift the rules refuse, and catching it here means
 * the owner is told which day disagrees instead of seeing a denial.
 *
 * `markedAt` must be the value `fs.serverTimestamp()` returns, because
 * the rules compare it with request.time and NOTHING else can equal it.
 * The client cannot prove the stamp IS that value without reaching into
 * the SDK's own fields: the sentinel exposes no `serverTimestamp`
 * property to read (it is a FieldValue whose only own field is its
 * method name), and a check written against a private field would die
 * silently on the next SDK upgrade — every mark refused, no error the
 * shop could act on. So this checks what is certain from outside: that
 * the stamp is not one of the client clocks the rules WILL refuse — a
 * Date, a number or a string. Accepting a value the server turns down is
 * the safe direction to be wrong in; refusing one the server would take
 * is not. The server stays the authority on the rest.
 *
 * @param {object} doc    the leave document as the client would write it
 * @param {string} pathKey  the dateKey in the document's own path
 * @returns {boolean}
 */
export function isValidLeaveDoc(doc, pathKey) {
  if (!doc || typeof doc !== "object") return false;

  const keys = Object.keys(doc);
  if (keys.length !== LEAVE_DOC_FIELDS.length) return false;
  for (const field of LEAVE_DOC_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(doc, field)) return false;
  }

  if (typeof doc.dateKey !== "string" || !LEAVE_DATE_KEY_REGEX.test(doc.dateKey)) return false;
  /* The mark belongs to the day it is filed under, or not at all. */
  if (doc.dateKey !== pathKey) return false;
  if (typeof doc.markedBy !== "string" || doc.markedBy.length < 1) return false;

  /* Every hand-rolled clock is refused, and they are distinguishable
     from the sentinel without knowing its internals: a client clock
     arrives as a Date, a number or a string. `null`/`undefined` are
     refused too, because a missing stamp is a missing field as far as
     request.time is concerned. */
  const stamp = doc.markedAt;
  if (stamp === null || typeof stamp === "undefined") return false;
  if (stamp instanceof Date || typeof stamp === "number" || typeof stamp === "string") return false;
  if (typeof stamp !== "object") return false;

  return true;
}

/** A fresh leave mark for `dateKey`, stamped with the server's clock. */
export function buildLeaveDoc(dateKey, uid, serverTimestampSentinel) {
  return {
    dateKey,
    markedAt: serverTimestampSentinel,
    markedBy: uid,
  };
}
