/* =========================================================
   Month calendar tests
   -----------------------------------------------------------------
   The calendar is the only screen whose whole job is to be right
   about dates. It reads a month, decides which days the shop still
   owes, and draws it Monday-first. Every one of those is a place a
   plain off-by-one lands: a grid that starts on Sunday, a February
   that runs to 29 when it should be 28, a day in the future counted
   as "missed", or a day with a broken head quietly drawn as a
   confident rupee figure.

   None of that needs Firebase, which is why js/calendar.js imports
   none - so the whole grid can be pinned here.
   ========================================================= */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DAY_STATUS,
  WEEKDAY_LABELS,
  currentYearMonth,
  shiftMonth,
  monthBounds,
  monthLabel,
  dayCellLabel,
  buildGrid,
  monthTotals,
  missedDays,
  dateKeyFromSearch,
} from "../js/calendar.js";
import { daysBetweenDateKeys, isBackfilledRow } from "../js/day-ledger.js";
import { todayKolkata } from "../js/utils.js";

/** A stored day head as fetchMonthHeads() hands one over. */
function head(counters, state = "open") {
  return { dateKey: null, state, counters };
}

/** Monday = 0 ... Sunday = 6, read back from the dateKey itself. */
function weekdayIndex(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay() + 6) % 7;
}

/** The in-month cells of a grid. */
function inMonthCells(cells) {
  return cells.filter((c) => c.inMonth);
}

/* ---------------- Month arithmetic ---------------- */

test("monthBounds: brackets a month with the two keys the read asks for", () => {
  assert.deepEqual(monthBounds("2026-09"), {
    yearMonth: "2026-09",
    firstKey: "2026-09-01",
    lastKey: "2026-09-30",
    days: 30,
  });

  assert.equal(monthBounds("2026-02").days, 28);
  assert.equal(monthBounds("2024-02").days, 29, "2024 is a leap year");
  assert.equal(monthBounds("2100-02").days, 28, "2100 is not");
  assert.equal(monthBounds("2026-01").lastKey, "2026-01-31");
  assert.equal(monthBounds("2026-12").lastKey, "2026-12-31");
});

test("monthBounds: refuses anything that is not a month", () => {
  for (const bad of ["", "2026", "2026-13", "2026-00", "2026-9", "sept-2026", null, undefined, 202609]) {
    assert.equal(monthBounds(bad), null, `monthBounds(${JSON.stringify(bad)}) should be null`);
  }
});

test("shiftMonth: whole months, across year ends and short months", () => {
  assert.equal(shiftMonth("2026-09", 1), "2026-10");
  assert.equal(shiftMonth("2026-09", -1), "2026-08");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-12", -12), "2025-12");
  assert.equal(shiftMonth("2026-09", 0), "2026-09");
  /* Built on the 1st, so a shift can never be dragged into the month
     after by a short month - 31 Jan + 1 month is 28 Feb, not 3 March. */
  assert.equal(shiftMonth("2026-01", 1), "2026-02");
  assert.equal(shiftMonth("2024-01", 1), "2024-02");
  assert.equal(shiftMonth("2026-09", "nonsense"), "2026-09");
  assert.equal(shiftMonth("2026-13", 1), null);
  assert.equal(shiftMonth("nope", 1), null);
});

test("currentYearMonth: agrees with the shop's own date, not the browser's", () => {
  assert.equal(currentYearMonth("2026-09-03"), "2026-09");
  assert.equal(currentYearMonth("2026-01-31"), "2026-01");
  assert.equal(currentYearMonth("bogus"), todayKolkata().slice(0, 7));
  assert.equal(currentYearMonth(), todayKolkata().slice(0, 7));
});

test("labels: a month and a day are named the way a shop would name them", () => {
  assert.equal(monthLabel("2026-09"), "September 2026");
  assert.equal(monthLabel("2026-01"), "January 2026");
  assert.equal(monthLabel("nope"), "");

  assert.equal(dayCellLabel("2026-09-03"), "3 Sept");
  assert.equal(dayCellLabel("2026-12-25"), "25 Dec");
  assert.equal(dayCellLabel("rubbish"), "");
});

test("WEEKDAY_LABELS starts on Monday", () => {
  assert.equal(WEEKDAY_LABELS.length, 7);
  assert.equal(WEEKDAY_LABELS[0], "Mon");
  assert.equal(WEEKDAY_LABELS[6], "Sun");
});

/* ---------------- The grid ---------------- */

test("buildGrid: always six whole weeks, Monday first", () => {
  const cells = buildGrid({ yearMonth: "2026-09", todayKey: "2026-09-15" });

  assert.equal(cells.length, 42);
  assert.equal(weekdayIndex(cells[0].dateKey), 0, "the grid starts on a Monday");
  assert.equal(weekdayIndex(cells[41].dateKey), 6, "and ends on a Sunday");

  /* Consecutive, with no day skipped or repeated - the failure that makes
     a month look right at a glance and be wrong in the ledger. */
  for (let i = 1; i < cells.length; i += 1) {
    assert.equal(daysBetweenDateKeys(cells[i - 1].dateKey, cells[i].dateKey), 1);
  }
});

test("buildGrid: the month occupies exactly its own days, neighbours are outside", () => {
  for (const month of ["2026-02", "2026-09", "2024-02", "2026-12"]) {
    const cells = buildGrid({ yearMonth: month, todayKey: "2026-09-15" });
    const own = inMonthCells(cells);
    assert.equal(own.length, monthBounds(month).days, `${month} should own its own day count`);
    assert.ok(own.every((c) => c.dateKey.startsWith(month)));
    assert.ok(cells.some((c) => !c.inMonth), `${month} should pad with neighbouring days`);
  }
});

test("buildGrid: today is marked exactly once", () => {
  const cells = buildGrid({ yearMonth: "2026-09", todayKey: "2026-09-15" });
  assert.equal(cells.filter((c) => c.isToday).length, 1);
  assert.equal(cells.find((c) => c.isToday).dateKey, "2026-09-15");
});

test("buildGrid: a day with sales is FILLED, and a closed one is CLOSED", () => {
  const cells = buildGrid({
    yearMonth: "2026-09",
    todayKey: "2026-09-15",
    heads: {
      "2026-09-03": head({ txnCount: 3, grossPaise: 50000, collectedPaise: 40000, duePaise: 10000 }),
      "2026-09-04": head({ txnCount: 1, grossPaise: 25000, collectedPaise: 25000, duePaise: 0 }, "closed"),
    },
  });
  const byKey = Object.fromEntries(cells.map((c) => [c.dateKey, c]));

  assert.equal(byKey["2026-09-03"].status, DAY_STATUS.FILLED);
  assert.equal(byKey["2026-09-03"].txnCount, 3);
  assert.equal(byKey["2026-09-03"].grossPaise, 50000);
  assert.equal(byKey["2026-09-03"].duePaise, 10000);
  assert.equal(byKey["2026-09-03"].closed, false);

  assert.equal(byKey["2026-09-04"].status, DAY_STATUS.CLOSED);
  assert.equal(byKey["2026-09-04"].closed, true);
  assert.equal(byKey["2026-09-04"].grossPaise, 25000);
});

test("buildGrid: a day with nothing recorded is EMPTY, not a zero-sales day", () => {
  const cells = buildGrid({ yearMonth: "2026-09", todayKey: "2026-09-15" });
  const empty = cells.filter((c) => c.inMonth && c.status === DAY_STATUS.EMPTY);

  assert.ok(empty.length > 0);
  assert.ok(
    empty.every((c) => c.txnCount === 0 && c.grossPaise === 0),
    "an empty day carries no figures",
  );
});

test("buildGrid: a future day is FUTURE even when a head somehow exists for it", () => {
  const cells = buildGrid({
    yearMonth: "2026-09",
    todayKey: "2026-09-15",
    heads: {
      "2026-09-20": head({ txnCount: 9, grossPaise: 99900, collectedPaise: 99900, duePaise: 0 }),
    },
  });
  const future = cells.find((c) => c.dateKey === "2026-09-20");

  assert.equal(future.status, DAY_STATUS.FUTURE);
  assert.equal(future.isFuture, true);
  /* Today's own figures must survive: the day is read, not skipped. */
  assert.equal(cells.find((c) => c.dateKey === "2026-09-15").status, DAY_STATUS.EMPTY);
});

test("buildGrid: a head whose counters do not add up is treated as unusable", () => {
  /* The rules refuse to write this, but a ledger that paints a confident
     figure from a head it cannot account for is worse than one that admits
     the day is unknown. */
  const cells = buildGrid({
    yearMonth: "2026-09",
    todayKey: "2026-09-15",
    heads: {
      "2026-09-03": head({ txnCount: 2, grossPaise: 50000, collectedPaise: 50000, duePaise: 10000 }),
      "2026-09-04": head({ txnCount: 1, grossPaise: 10000, collectedPaise: 4000, duePaise: 0 }),
    },
  });
  const byKey = Object.fromEntries(cells.map((c) => [c.dateKey, c]));

  assert.equal(byKey["2026-09-03"].status, DAY_STATUS.EMPTY);
  assert.equal(byKey["2026-09-04"].status, DAY_STATUS.EMPTY);
});

test("buildGrid: padded days never carry another month's figures", () => {
  const cells = buildGrid({
    yearMonth: "2026-09",
    todayKey: "2026-09-15",
    heads: {
      "2026-08-31": head({ txnCount: 4, grossPaise: 40000, collectedPaise: 40000, duePaise: 0 }),
    },
  });
  const padded = cells.find((c) => c.dateKey === "2026-08-31");

  assert.equal(padded.inMonth, false);
  assert.equal(padded.grossPaise, 0);
  assert.equal(padded.txnCount, 0);
});

test("buildGrid: a nonsense month is an empty grid, not a crash", () => {
  assert.deepEqual(buildGrid({ yearMonth: "nonsense" }), []);
  assert.deepEqual(buildGrid(), []);
});

/* ---------------- Totals ---------------- */

test("monthTotals: sums the recorded days and counts the rest as missing", () => {
  const cells = buildGrid({
    yearMonth: "2026-09",
    todayKey: "2026-09-10",
    heads: {
      "2026-09-01": head({ txnCount: 2, grossPaise: 30000, collectedPaise: 20000, duePaise: 10000 }),
      "2026-09-02": head({ txnCount: 1, grossPaise: 10000, collectedPaise: 10000, duePaise: 0 }, "closed"),
    },
  });
  const t = monthTotals(cells);

  assert.equal(t.grossPaise, 40000);
  assert.equal(t.collectedPaise, 30000);
  assert.equal(t.duePaise, 10000);
  assert.equal(t.txnCount, 3);
  assert.equal(t.daysRecorded, 2);
  assert.equal(t.daysClosed, 1);

  /* The tenth is the last day that has happened; the rest of the month
     is not yet owed to anyone. */
  assert.equal(t.daysInMonth, 10);
  assert.equal(t.daysMissed, 8);
});

test("monthTotals: a month with nothing in it is all missing, not zero-sold", () => {
  const cells = buildGrid({ yearMonth: "2026-09", todayKey: "2026-09-05" });
  const t = monthTotals(cells);

  assert.equal(t.grossPaise, 0);
  assert.equal(t.txnCount, 0);
  assert.equal(t.daysRecorded, 0);
  assert.equal(t.daysInMonth, 5);
  assert.equal(t.daysMissed, 5);
});

test("monthTotals: tolerates junk instead of adding NaN to the month", () => {
  const t = monthTotals([null, {}, { inMonth: true, isFuture: false, status: DAY_STATUS.FILLED, grossPaise: "x" }]);

  assert.equal(t.grossPaise, 0);
  assert.equal(Number.isFinite(t.grossPaise), true);
});

test("missedDays: the past days with nothing on them, oldest first and capped", () => {
  const cells = buildGrid({ yearMonth: "2026-09", todayKey: "2026-09-04" });
  const missed = missedDays(cells);

  /* Today counts while it is still today: the shop fills the ledger in
     the evening, so until then today's cell is one of the days owed. */
  assert.deepEqual(missed, ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
  assert.deepEqual(missedDays(cells, 2), ["2026-09-01", "2026-09-02"]);
  assert.deepEqual(missedDays(cells, 0), []);
});

test("missedDays: a recorded or closed day is never listed as missing", () => {
  const cells = buildGrid({
    yearMonth: "2026-09",
    todayKey: "2026-09-04",
    heads: {
      "2026-09-01": head({ txnCount: 1, grossPaise: 100, collectedPaise: 100, duePaise: 0 }),
      "2026-09-02": head({ txnCount: 1, grossPaise: 100, collectedPaise: 100, duePaise: 0 }, "closed"),
    },
  });

  assert.deepEqual(missedDays(cells), ["2026-09-03", "2026-09-04"]);
});

/* ---------------- URL hints ---------------- */

test("dateKeyFromSearch: takes a usable day and ignores a broken one", () => {
  assert.equal(dateKeyFromSearch("?date=2026-09-03"), "2026-09-03");
  assert.equal(dateKeyFromSearch("date=2026-09-03"), "2026-09-03");
  assert.equal(dateKeyFromSearch("?date=2026-09-03&x=1"), "2026-09-03");

  /* A hand-edited or stale link must not park a page on a day that does
     not exist - including one that does not exist yet. */
  assert.equal(dateKeyFromSearch("?date=2026-13-01"), null);
  assert.equal(dateKeyFromSearch("?date=2026-02-30"), null);
  assert.equal(dateKeyFromSearch("?date=tomorrow"), null);
  assert.equal(dateKeyFromSearch("?date="), null);
  assert.equal(dateKeyFromSearch(""), null);
});

/* ---------------- Shared day arithmetic ---------------- */

test("daysBetweenDateKeys: signed, and correct across a month end", () => {
  assert.equal(daysBetweenDateKeys("2026-09-03", "2026-09-03"), 0);
  assert.equal(daysBetweenDateKeys("2026-09-03", "2026-09-05"), 2);
  assert.equal(daysBetweenDateKeys("2026-09-05", "2026-09-03"), -2);
  assert.equal(daysBetweenDateKeys("2026-01-31", "2026-02-01"), 1);
  assert.equal(daysBetweenDateKeys("2024-02-28", "2024-03-01"), 2, "leap day counted");
  assert.equal(daysBetweenDateKeys("2026-02-28", "2026-03-01"), 1);
});

/* ---------------- Backfilled rows ---------------- */

test("isBackfilledRow: a row typed up on a later day is marked, not passed off as an evening sale", () => {
  /* Filed on the 3rd, entered on the 5th at 21:40 Kolkata (16:10 UTC). */
  const entry = new Date("2026-09-05T16:10:00Z");
  assert.equal(isBackfilledRow({ createdAt: entry }, "2026-09-03"), true);

  /* Entered during the evening of the day it belongs to. */
  assert.equal(isBackfilledRow({ createdAt: new Date("2026-09-03T16:10:00Z") }, "2026-09-03"), false);
  /* Just after midnight in Kolkata is still the next business day, and
     it is Kolkata's midnight that ends a trading day - not UTC's. */
  assert.equal(isBackfilledRow({ createdAt: new Date("2026-09-03T18:40:00Z") }, "2026-09-03"), true);

  /* A Firestore Timestamp, as it actually arrives from the SDK. */
  assert.equal(
    isBackfilledRow({ createdAt: { toDate: () => new Date("2026-09-06T05:00:00Z") } }, "2026-09-03"),
    true,
  );
  assert.equal(
    isBackfilledRow({ createdAt: { seconds: 1788624600 } }, "2026-09-03"),
    true,
    "the legacy { seconds } shape is understood too",
  );
});

test("isBackfilledRow: never guesses", () => {
  assert.equal(isBackfilledRow(null, "2026-09-03"), false);
  assert.equal(isBackfilledRow({}, "2026-09-03"), false, "no timestamp means no claim");
  assert.equal(isBackfilledRow({ createdAt: "not a date" }, "2026-09-03"), false);
  assert.equal(isBackfilledRow({ createdAt: new Date() }, "rubbish"), false);
});