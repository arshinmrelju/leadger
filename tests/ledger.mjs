import test from "node:test";
import assert from "node:assert/strict";

import {
  toPaise,
  formatINR,
  paiseToInput,
  sanitizeQuantity,
  rateToPaise,
  computeTotalPaise,
  isPaymentMethod,
  statusForMethod,
  methodLabel,
  isValidDateKey,
  MAX_QUANTITY,
  MAX_RATE_PAISE,
} from "../js/utils.js";

import {
  shiftDateKey,
  dayHeading,
  formatEntryTime,
  isFilterableMethod,
  isFilterableStatus,
  filterDayRows,
  dayTotals,
  mergeDayPage,
  sortDayRows,
} from "../js/day-ledger.js";

test("toPaise: rupees -> integer paise", () => {
  assert.equal(toPaise(10), 1000);
  assert.equal(toPaise("10"), 1000);
  assert.equal(toPaise("10.5"), 1050);
  assert.equal(toPaise("10.50"), 1050);
  assert.equal(toPaise("₹10,000"), 1000000);
  assert.ok(Number.isNaN(toPaise("abc")));
  assert.ok(Number.isNaN(toPaise("")));
  assert.ok(Number.isNaN(toPaise(null)));
});

test("sanitizeQuantity: accepts whole numbers above zero", () => {
  assert.equal(sanitizeQuantity("1"), 1);
  assert.equal(sanitizeQuantity(1), 1);
  assert.equal(sanitizeQuantity("5"), 5);
  assert.equal(sanitizeQuantity(" "), null);
  assert.equal(sanitizeQuantity(0), null);
  assert.equal(sanitizeQuantity(-3), null);
  assert.equal(sanitizeQuantity("1.5"), null);
  assert.equal(sanitizeQuantity("abc"), null);
  assert.equal(sanitizeQuantity(Number.NaN), null);
  assert.equal(sanitizeQuantity(Number.POSITIVE_INFINITY), null);
  assert.equal(sanitizeQuantity(Number.NEGATIVE_INFINITY), null);
  assert.equal(sanitizeQuantity(MAX_QUANTITY + 1), null);
  assert.equal(sanitizeQuantity(MAX_QUANTITY), MAX_QUANTITY);
});

test("rateToPaise: safe rate parsing", () => {
  assert.equal(rateToPaise("10"), 1000);
  assert.equal(rateToPaise("10.50"), 1050);
  assert.equal(rateToPaise("0"), 0);
  assert.equal(rateToPaise("0.00"), 0);
  assert.equal(rateToPaise("-5"), null);
  assert.equal(rateToPaise("abc"), null);
  assert.equal(rateToPaise(Number.NaN), null);
  assert.equal(rateToPaise(Number.POSITIVE_INFINITY), null);
  assert.equal(rateToPaise(MAX_RATE_PAISE / 100), MAX_RATE_PAISE);
  assert.equal(rateToPaise(MAX_RATE_PAISE / 100 + 0.01), null);
});

test("computeTotalPaise: quantity x rate with integer math", () => {
  assert.equal(computeTotalPaise(2, 500), 1000);
  assert.equal(computeTotalPaise(1, 0), 0);
  assert.equal(computeTotalPaise(3, 1050), 3150);
  assert.equal(computeTotalPaise(0, 500), null);
  assert.equal(computeTotalPaise(-1, 500), null);
  assert.equal(computeTotalPaise(1, -1), null);
  assert.equal(computeTotalPaise(1.5, 500), null);
  assert.equal(computeTotalPaise(Number.NaN, 500), null);
  assert.equal(computeTotalPaise(1, Number.NaN), null);
  assert.equal(computeTotalPaise(Number.POSITIVE_INFINITY, 500), null);
});

test("payment methods + status mapping", () => {
  assert.equal(isPaymentMethod("cash"), true);
  assert.equal(isPaymentMethod("upi"), true);
  assert.equal(isPaymentMethod("card"), true);
  assert.equal(isPaymentMethod("due"), true);
  assert.equal(isPaymentMethod("CASH"), false);
  assert.equal(isPaymentMethod("cheque"), false);
  assert.equal(isPaymentMethod(null), false);

  assert.equal(statusForMethod("due"), "pending");
  assert.equal(statusForMethod("cash"), "paid");
  assert.equal(statusForMethod("upi"), "paid");
  assert.equal(statusForMethod("card"), "paid");
  assert.equal(statusForMethod("nope"), null);

  assert.equal(methodLabel("cash"), "Cash");
  assert.equal(methodLabel("upi"), "UPI");
  assert.equal(methodLabel("card"), "Card");
  assert.equal(methodLabel("due"), "Due");
});

test("format helpers", () => {
  assert.equal(formatINR(1050), "₹10.50");
  assert.equal(formatINR(500), "₹5");
  assert.equal(formatINR(0), "₹0");
  assert.equal(paiseToInput(1050), "10.50");
  assert.equal(paiseToInput(500), "5");
  assert.equal(paiseToInput(0), "0");
});
/* =========================================================
   Daily ledger (js/day-ledger.js)
   ========================================================= */

/** Build a normalized-shaped row for the view helpers. */
function row(over = {}) {
  return {
    txnId: "txn-1",
    serviceName: "Print",
    customerName: "",
    quantity: 1,
    ratePaise: 1000,
    totalPaise: 1000,
    paymentMethod: "cash",
    methodLabel: "Cash",
    status: "paid",
    createdAt: null,
    ...over,
  };
}

test("isValidDateKey: real calendar dates only", () => {
  assert.equal(isValidDateKey("2026-09-26"), true);
  assert.equal(isValidDateKey("2026-02-29"), false); // 2026 is not a leap year
  assert.equal(isValidDateKey("2026-13-01"), false);
  assert.equal(isValidDateKey("2026-09-32"), false);
  assert.equal(isValidDateKey("26-09-2026"), false);
  assert.equal(isValidDateKey(""), false);
  assert.equal(isValidDateKey(null), false);
});

test("shiftDateKey: previous and next day", () => {
  assert.equal(shiftDateKey("2026-09-26", -1), "2026-09-25");
  assert.equal(shiftDateKey("2026-09-26", 1), "2026-09-27");
  assert.equal(shiftDateKey("2026-09-26", 0), "2026-09-26");
  /* Month and year boundaries, including a leap day. */
  assert.equal(shiftDateKey("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDateKey("2024-03-01", -1), "2024-02-29");
  assert.equal(shiftDateKey("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDateKey("2026-12-31", 1), "2027-01-01");
  /* A 400-day jump still lands correctly (no month-length drift):
     2026-09-26 +365 lands on 2027-09-26, +35 more on 2027-10-31. */
  assert.equal(shiftDateKey("2026-09-26", 400), "2027-10-31");
  assert.equal(shiftDateKey("2026-09-26", -400), "2025-08-22");
  assert.equal(shiftDateKey("nope", 1), null);
});

test("dayHeading: long weekday label for a business day", () => {
  /* en-GB spells the short month "Sept", and the day is rendered
     zero-padded, so this asserts the real Intl output. */
  assert.equal(dayHeading("2026-09-26"), "Saturday, 26 Sept 2026");
  assert.equal(dayHeading("2026-12-01"), "Tuesday, 01 Dec 2026");
  assert.equal(dayHeading("bad"), "");
});

test("formatEntryTime: Asia/Kolkata wall clock", () => {
  /* 04:55 UTC is 10:25 in Kolkata; 19:40 UTC is 01:10 the next day. */
  assert.equal(formatEntryTime(new Date("2026-09-26T04:55:00Z")), "10:25 AM");
  assert.equal(formatEntryTime(new Date("2026-09-26T19:40:00Z")), "1:10 AM");
  assert.equal(formatEntryTime(new Date("2026-09-26T18:31:00Z")), "12:01 AM");
  /* A Firestore Timestamp resolves the same as its Date equivalent. */
  assert.equal(formatEntryTime({ seconds: 1789254000 }), formatEntryTime(new Date(1789254000 * 1000)));
  assert.equal(formatEntryTime(null), "—");
  assert.equal(formatEntryTime("not a date"), "—");
});

test("filter guards: only known method and status values pass", () => {
  assert.equal(isFilterableMethod("cash"), true);
  assert.equal(isFilterableMethod("due"), true);
  assert.equal(isFilterableMethod("cheque"), false);
  assert.equal(isFilterableMethod("any"), false);
  assert.equal(isFilterableStatus("paid"), true);
  assert.equal(isFilterableStatus("pending"), true);
  assert.equal(isFilterableStatus("refunded"), false);
  assert.equal(isFilterableStatus("all"), false);
});

test("filterDayRows: search, payment filter and status filter", () => {
  const rows = [
    row({ txnId: "a", serviceName: "Print", customerName: "Asha", paymentMethod: "cash", status: "paid" }),
    row({ txnId: "b", serviceName: "Binding", customerName: "Ravi", paymentMethod: "upi", status: "paid" }),
    row({ txnId: "c", serviceName: "Lamination", customerName: "Asha", paymentMethod: "due", status: "pending" }),
  ];

  /* No filters returns everything. */
  assert.equal(filterDayRows(rows).length, 3);
  /* An unknown method is treated as "any" rather than hiding the day. */
  assert.equal(filterDayRows(rows, { method: "cheque" }).length, 3);

  assert.equal(filterDayRows(rows, { method: "cash" }).length, 1);
  assert.equal(filterDayRows(rows, { status: "pending" }).length, 1);
  assert.equal(filterDayRows(rows, { status: "pending" })[0].txnId, "c");
  assert.equal(filterDayRows(rows, { method: "due", status: "pending" }).length, 1);

  /* Search is case-insensitive across service and customer. */
  assert.equal(filterDayRows(rows, { query: "print" }).length, 1);
  assert.equal(filterDayRows(rows, { query: "ASHA" }).length, 2);
  assert.equal(filterDayRows(rows, { query: "  print  " }).length, 1);
  assert.equal(filterDayRows(rows, { query: "zzz" }).length, 0);

  /* Filters compose. */
  assert.equal(filterDayRows(rows, { query: "asha", method: "due" }).length, 1);
  assert.equal(filterDayRows(rows, { query: "asha", method: "cash" }).length, 1);

  /* Bad input is tolerated. */
  assert.deepEqual(filterDayRows(null), []);
  assert.deepEqual(filterDayRows([null, undefined]), []);
});

test("dayTotals: counts and per-method sums", () => {
  const rows = [
    row({ paymentMethod: "cash", totalPaise: 5000, status: "paid" }),
    row({ paymentMethod: "upi", totalPaise: 2500, status: "paid" }),
    row({ paymentMethod: "card", totalPaise: 1500, status: "paid" }),
    row({ paymentMethod: "due", totalPaise: 4000, status: "pending" }),
  ];

  const t = dayTotals(rows);
  assert.equal(t.count, 4);
  /* Revenue is the gross booked value, due included. */
  assert.equal(t.revenuePaise, 13000);
  assert.equal(t.cashPaise, 5000);
  assert.equal(t.upiPaise, 2500);
  assert.equal(t.cardPaise, 1500);
  assert.equal(t.duePaise, 4000);

  const empty = dayTotals([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.revenuePaise, 0);
  assert.equal(dayTotals(null).count, 0);
  assert.equal(dayTotals([null, row()]).count, 1);
});

test("mergeDayPage: appends without duplicating ids", () => {
  const first = [row({ txnId: "a" }), row({ txnId: "b" })];
  const second = [row({ txnId: "b" }), row({ txnId: "c" })];

  const merged = mergeDayPage(first, second);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((r) => r.txnId), ["a", "b", "c"]);

  /* An empty page leaves the original array alone. */
  assert.equal(mergeDayPage(first, []), first);
  assert.equal(mergeDayPage(null, [row({ txnId: "z" })]).length, 1);
});

test("sortDayRows: newest first, stable, does not mutate", () => {
  const rows = [
    row({ txnId: "old", createdAt: { seconds: 1000 } }),
    row({ txnId: "new", createdAt: { seconds: 3000 } }),
    row({ txnId: "mid", createdAt: { seconds: 2000 } }),
  ];
  const sorted = sortDayRows(rows);
  assert.deepEqual(sorted.map((r) => r.txnId), ["new", "mid", "old"]);
  assert.deepEqual(rows.map((r) => r.txnId), ["old", "new", "mid"]);
  assert.deepEqual(sortDayRows([]), []);
});