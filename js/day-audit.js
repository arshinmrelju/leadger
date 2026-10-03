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
  counterStepAllowed,
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
 * The six fields firestore.rules reads off a sale's amounts map:
 * validAmounts pins them with hasOnly, and headSteppedBy /
 * headShiftedBy then read every one of them by name.
 */
const AMOUNT_KEYS = Object.freeze(["gross", "cash", "upi", "card", "due", "collected"]);

/**
 * Can firestore.rules use this sale's amounts map AT ALL?
 *
 * The client's own reader is forgiving and the rules' is not, and that
 * difference is the whole answer to "the totals add up yet the delete is
 * refused":
 *
 *   - amountsFromDoc() fills an absent bucket with 0 and carries on, so
 *     the day still adds up and the check reports it in step.
 *   - headSteppedBy() reads `a.cash` directly. On a document without
 *     that key the rules engine RAISES rather than answering false, the
 *     evaluation errors, and the entire batch is refused — a delete
 *     cannot happen, an edit cannot happen, and no amount of fixing the
 *     head will change it, because the head is not what is wrong.
 *
 * `validAmounts` requires all six keys and requires each to be an int,
 * so a document missing one was written by a build older than the
 * per-method split, and one holding a string was written by something
 * that did not write paise as numbers.
 *
 * Returning the REASON rather than a bare false is what lets the report
 * name the missing field, which is the difference between "this row is
 * broken" and a fix.
 *
 * @param {object} doc  a stored sale document
 * @returns {string|null} why the rules cannot use it, or null if they can
 */
export function amountsRulesCannotUse(doc) {
  const a = doc ? doc.amounts : null;
  if (!a || typeof a !== "object") return "it carries no amounts map";

  const missing = AMOUNT_KEYS.filter((k) => a[k] === undefined || a[k] === null);
  if (missing.length) {
    return "its amounts map is missing " + missing.join(", ");
  }

  /* `is int` in the rules, and a string here does not merely compare
     unequal: multiplying it by a step is not an operation the language
     has, so the write errors the same way a missing key does. */
  const notInt = AMOUNT_KEYS.filter((k) => !Number.isInteger(a[k]));
  if (notInt.length) {
    return "its amounts are not whole paise: " + notInt.join(", ");
  }

  return null;
}

/**
 * Add up a day's sales into the counter set the head should be
 * carrying. A row the rules cannot read is reported rather than
 * guessed at: guessing would put a number in the report that no
 * rule would ever agree with.
 *
 * @param {object[]} rows  stored sale documents for one business day
 * @returns {{counters: object, saleCount: number, unreadable: object[]}}
 */
export function sumDayCounters(rows) {
  let counters = emptyCounters();
  const unreadable = [];
  let saleCount = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    saleCount += 1;

    const why = amountsRulesCannotUse(row);
    if (why) {
      unreadable.push({ txnId: String(row.txnId || "(unnamed)"), why });
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
          "Their totals may still add up exactly — this is not a head out of step. It is that firestore.rules " +
          "reads a field off each of them that is not there, and a missing field makes the engine raise " +
          "instead of answer, so the whole write is refused however healthy the head is: " +
          a.unreadable.map((u) => u.txnId + " (" + u.why + ")").join("; ") +
          ". No repair of the head will free them; the document itself has to be completed.",
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

/* =========================================================
   The repair
   ------------------------------------------------------------
   firestore.rules' head rule already accepts a bounded move on
   its own: a sale count that shifts by no more than one, money
   that moves by no more than HEAD_MONEY_STEP per field, and an
   after-set that still adds up (boundedCounterStep, mirrored by
   counterStepAllowed).

   That is enough to undo the commonest drift — a head still
   carrying one phantom sale, left behind by a console delete —
   WITHOUT a rule change and WITHOUT widening what a write may
   do. The correction is a plain head write; no sale is touched,
   so no sale rule is involved and nothing can be forged through
   it. Anything the bound would not accept is reported as needing
   more than this screen can do, rather than being forced through.
   ========================================================= */

/**
 * What can be done about a report. Ordered so the first test that
 * matches is the one that explains itself to the shopkeeper.
 */
export const REPAIR_STATUS = Object.freeze({
  /** The head is in step. Nothing to repair. */
  NOT_NEEDED: "not-needed",
  /** A correction exists and the rules will accept it. */
  READY: "ready",
  /** Drift is real but larger than a single sale-sized move. */
  TOO_LARGE: "too-large",
  /** The day is closed, and a closed head's counters are frozen. */
  CLOSED: "closed",
  /** There is no head, so there is nothing to correct against. */
  NO_HEAD: "no-head",
  /** No trustworthy number to write — an unreadable or partial day. */
  UNUSABLE: "unusable",
});

/**
 * Decide whether a report can be acted on, and produce the exact
 * counters the repair would write.
 *
 * The report is the only input on purpose: the numbers a repair
 * writes must be the very numbers the check printed, and deriving
 * them a second time here is how the two would ever disagree.
 *
 * A BAD_HEAD is not rejected on sight. boundedCounterStep judges
 * the destination rather than the starting point, so a head whose
 * counters are nonsense can still be written back to a valid set
 * provided the move is sale-sized — which is precisely the case
 * worth rescuing. The bound decides, not the label.
 *
 * @param {object} audit  a report from auditDayCounters()
 * @returns {{status: string, repairable: boolean, target: object|null,
 *            steps: object[], reason: string}}
 */
export function planDayRepair(audit) {
  const a = audit && typeof audit === "object" ? audit : auditDayCounters();
  const day = a.dateKey || "this day";
  const sales = a.saleCount === 1 ? "1 sale" : a.saleCount + " sales";

  const before = {};
  const target = {};
  for (const field of COUNTER_FIELDS) {
    before[field] = asInt(a.headCounters ? a.headCounters[field] : 0);
    target[field] = asInt(a.actualCounters ? a.actualCounters[field] : 0);
  }

  const steps = AUDIT_FIELDS.filter((f) => before[f.field] !== target[f.field]).map((f) => ({
    field: f.field,
    label: f.label,
    money: f.money,
    before: before[f.field],
    after: target[f.field],
    delta: target[f.field] - before[f.field],
  }));

  const plan = (status, reason) => ({
    status,
    repairable: status === REPAIR_STATUS.READY,
    target: status === REPAIR_STATUS.READY ? target : null,
    steps,
    reason,
  });

  if (!a.headCounters) {
    return plan(
      REPAIR_STATUS.NO_HEAD,
      day + " has " + sales + " but no day head at all. There is nothing to correct — the head has to be " +
        "opened, and no write to this day is allowed until it is."
    );
  }

  if (a.unreadable.length) {
    return plan(
      REPAIR_STATUS.UNUSABLE,
      a.unreadable.length === 1
        ? "One sale on " + day + " has an amounts map the rules cannot read (" +
          a.unreadable[0].why +
          "), so its contribution cannot be added up. Writing a total that leaves it out would make the day " +
          "wrong in a new way."
        : a.unreadable.length + " sales on " + day + " have amounts maps the rules cannot read, so their " +
          "contributions cannot be added up. Writing a total that leaves them out would make the day wrong in " +
          "a new way."
    );
  }

  if (a.truncated) {
    return plan(
      REPAIR_STATUS.UNUSABLE,
      "Not every sale on " + day + " could be read, so the sum is partial. Repairing to a partial sum would " +
        "be worse than leaving the head alone."
    );
  }

  if (a.ok) {
    return plan(REPAIR_STATUS.NOT_NEEDED, day + " is already in step. There is nothing to repair.");
  }

  /* Every branch that permits a closed head to change its counters
     requires them UNCHANGED (the close and reopen rules both pin
     `request.resource.data.counters == resource.data.counters`).
     A frozen head is not a rule bug, it is the point of closing a
     day, so this is reported rather than worked around. */
  if (a.state === "closed") {
    return plan(
      REPAIR_STATUS.CLOSED,
      day + " is closed. A closed day's counters are frozen by the rules on purpose — reopen the day, repair " +
        "it, then close it again."
    );
  }

  if (!counterStepAllowed(before, target)) {
    return plan(
      REPAIR_STATUS.TOO_LARGE,
      "The head for " + day + " is out by more than one sale" +
        (Math.abs(target.txnCount - before.txnCount) !== 1
          ? " (" + Math.abs(target.txnCount - before.txnCount) + " sales)"
          : "") +
        ". The rules only let a head move by one sale at a time, so this needs a person to look at the day's " +
        "sales rather than a button."
    );
  }

  return plan(
    REPAIR_STATUS.READY,
    "The head for " + day + " is out by " +
      (Math.abs(target.txnCount - before.txnCount) === 1 ? "one phantom sale" : "a corrupt counter") +
      ". Writing the day's real totals back is a move of the size the rules already allow, and it touches no " +
      "sale."
  );
}

/**
 * The sentence a refused write earns, with the cause named.
 *
 * Lives here rather than beside the toast so it can be tested: what the
 * shop is told after a refusal is the one thing in this path nobody
 * could check by reading the rules, and each verdict has to lead
 * somewhere different. "In step" is the interesting one — it says the
 * usual explanation does not apply, rather than repeating it.
 *
 * @param {object} audit  a report from auditDayCounters()
 * @param {object} [plan] a plan from planDayRepair(); computed if absent
 * @returns {string}
 */
export function describeRefusal(audit, plan) {
  const a = audit && typeof audit === "object" ? audit : auditDayCounters();
  const p = plan && typeof plan === "object" ? plan : planDayRepair(a);
  const day = a.dateKey || "this day";
  const said = describeAudit(a);

  if (a.ok) {
    return (
      "The ledger was not allowed to change that sale. " + day + " was checked as it stands and its totals do " +
      "add up, so this is not a day being out of step — the browser console has the details."
    );
  }

  const remedy = p.repairable
    ? "The Developer console's Day integrity card can put it back in one step."
    : "The Developer console's Day integrity card will show the difference in full.";

  return (
    said.headline + " Nothing on " + day + " can be changed until that is put right. " + remedy
  );
}