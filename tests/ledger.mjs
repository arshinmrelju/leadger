import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import {
  isQuotaExhausted,
  readsForQuery,
  SPARK_LIMITS,
  quotaResetTime,
} from "../js/quota.js";

import { createReadCache } from "../js/read-cache.js";

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
  receiptImageBytes,
  isStorableReceiptImage,
  RECEIPT_IMAGE_MAX_BYTES,
  RECEIPT_IMAGE_PREFIX,
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

import {
  SERVICE_CATALOG,
  SERVICE_CATALOG_GROUPS,
  DEFAULT_SERVICE_PRICE_RUPEES,
  SERVICE_SEED_PREFIX,
  catalogKey,
  catalogSeedId,
  findMissingCatalogServices,
} from "../js/service-catalog.js";

import {
  DAY_STATE,
  COUNTER_FIELDS,
  emptyCounters,
  splitAmounts,
  amountsFromDoc,
  isCounterSetValid,
  stepCounters,
  counterStepAllowed,
  HEAD_COUNT_STEP,
  HEAD_MONEY_STEP,
} from "../js/day-heads.js";

import {
  AUDIT_FIELDS,
  AUDIT_STATUS,
  REPAIR_STATUS,
  auditDayCounters,
  describeAudit,
  amountsRulesCannotUse,
  describeRefusal,
  planDayRepair,
  sumDayCounters,
} from "../js/day-audit.js";

import {
  serviceMatchesQuery,
  serviceTile,
  serviceGroupOf,
  groupServices,
  filterAndGroupServices,
  flattenOptions,
  countServiceRows,
  resultsSummary,
  nextActiveIndex,
  fixedPlacementCorrection,
} from "../js/service-picker.js";

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

/* =========================================================
   Default service catalog (js/service-catalog.js)
   -------------------------------------------------------------
   The catalog is written straight into Firestore by seedDefaultServices(),
   so every entry has to satisfy the same bounds the rules enforce on a
   hand-typed service. A bad entry here would fail the whole seed part-way
   through, on the customer's counter.
   ========================================================= */

test("catalog: every entry fits the services schema the rules enforce", () => {
  assert.ok(SERVICE_CATALOG.length > 0);

  for (const entry of SERVICE_CATALOG) {
    const where = entry.name;
    assert.ok(where.length >= 1 && where.length <= 80, `name length: ${where}`);
    assert.ok(String(entry.code).length <= 12, `code length: ${where}`);
    assert.ok(Number.isFinite(entry.sortOrder), `sortOrder is a number: ${where}`);
    /* rateToPaise is what createService validates with — a NaN here
       would throw and abort the seed. */
    assert.equal(rateToPaise(entry.price), 0, `seeded rate is ₹0: ${where}`);
    assert.ok(rateToPaise(entry.price) <= MAX_RATE_PAISE, `rate in range: ${where}`);
  }
});

test("catalog: names and tile codes are unique", () => {
  const names = SERVICE_CATALOG.map((e) => catalogKey(e.name));
  const codes = SERVICE_CATALOG.map((e) => e.code);
  const ids = SERVICE_CATALOG.map((e) => e.seedId);

  assert.equal(new Set(names).size, names.length, "duplicate service name in the catalog");
  /* Two services sharing a tile would be indistinguishable on the grid. */
  assert.equal(new Set(codes).size, codes.length, "duplicate tile code in the catalog");
  /* Two services sharing a document id would overwrite each other. */
  assert.equal(new Set(ids).size, ids.length, "duplicate seed id in the catalog");
});

test("catalog: seed ids are stable, namespaced and path-safe", () => {
  for (const entry of SERVICE_CATALOG) {
    assert.ok(entry.seedId.startsWith(SERVICE_SEED_PREFIX), `seed prefix: ${entry.name}`);
    assert.ok(entry.seedId.length <= 120, `seed id length: ${entry.name}`);
    /* A "/" in a document id would write to a different path. */
    assert.ok(!entry.seedId.includes("/"), `seed id is path-safe: ${entry.name}`);
    assert.ok(/^[a-z0-9_]+$/.test(entry.seedId), `seed id charset: ${entry.name}`);
  }
  /* Pure function of the name, so every device computes the same id. */
  assert.equal(catalogSeedId("Photocopy"), catalogSeedId("  PHOTOCOPY  "));
  const pcc = SERVICE_CATALOG.find((e) => e.name.startsWith("PCC"));
  assert.equal(catalogSeedId(pcc.name), pcc.seedId);
  assert.notEqual(catalogSeedId("Photocopy"), catalogSeedId("Photo Printing"));
  /* Names that slug identically must still get different ids. */
  assert.notEqual(catalogSeedId("Scan + Print"), catalogSeedId("Scan and Print"));
});

test("catalog: sortOrder runs in group order, so the groups stay together", () => {
  for (let i = 1; i < SERVICE_CATALOG.length; i += 1) {
    assert.ok(
      SERVICE_CATALOG[i].sortOrder > SERVICE_CATALOG[i - 1].sortOrder,
      `sortOrder must increase: ${SERVICE_CATALOG[i].name}`,
    );
  }

  /* A group's entries must sit in one contiguous run, and later groups
     must sort after earlier ones. */
  const seen = [];
  for (const entry of SERVICE_CATALOG) {
    if (seen[seen.length - 1] !== entry.group) seen.push(entry.group);
  }
  assert.deepEqual(seen, SERVICE_CATALOG_GROUPS.map((g) => g.id));
});

test("catalog: covers the counter's groups", () => {
  const labels = SERVICE_CATALOG_GROUPS.map((g) => g.label.toLowerCase());
  for (const expected of ["printing", "government", "online", "photo", "dtp", "bill"]) {
    assert.ok(
      labels.some((l) => l.includes(expected)),
      `catalog is missing a ${expected} group`,
    );
  }
  assert.equal(DEFAULT_SERVICE_PRICE_RUPEES, 0);
});

test("catalogKey: case and spacing are not meaningful in a service name", () => {
  assert.equal(catalogKey("PCC"), "pcc");
  assert.equal(catalogKey("  pcc  "), "pcc");
  assert.equal(catalogKey("Scan  +  Print"), "scan + print");
  assert.equal(catalogKey("Scan + Print"), "scan + print");
  assert.equal(catalogKey(null), "");
  assert.equal(catalogKey(undefined), "");
});

test("findMissingCatalogServices: a fresh shop gets the whole list", () => {
  assert.deepEqual(findMissingCatalogServices([]), SERVICE_CATALOG);
  assert.deepEqual(findMissingCatalogServices(null), SERVICE_CATALOG);
  assert.deepEqual(findMissingCatalogServices(undefined), SERVICE_CATALOG);
});

test("findMissingCatalogServices: matches by name, ignoring case and spacing", () => {
  /* A hand-typed "pcc" must not be seeded again as "PCC". */
  const existing = SERVICE_CATALOG.map((e) => ({ name: e.name.toLowerCase() }));
  assert.deepEqual(findMissingCatalogServices(existing), []);

  const almost = SERVICE_CATALOG.slice(1).map((e) => ({ name: e.name }));
  const missing = findMissingCatalogServices(almost);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].name, SERVICE_CATALOG[0].name);
});

test("findMissingCatalogServices: an archived service counts as present", () => {
  /* Services are never deletable (rules: allow delete: if false), so
     re-seeding must not resurrect an archived row as a second service. */
  const archived = [{ name: SERVICE_CATALOG[3].name, active: false }];
  const missing = findMissingCatalogServices(archived);
  assert.equal(missing.length, SERVICE_CATALOG.length - 1);
  assert.ok(!missing.some((m) => m.name === SERVICE_CATALOG[3].name));
});

test("findMissingCatalogServices: tolerates junk rows in the shop catalog", () => {
  const existing = [null, undefined, {}, { name: 7 }, { name: "Photocopy" }];
  const missing = findMissingCatalogServices(existing);
  assert.ok(!missing.some((m) => m.name === "Photocopy"));
  assert.equal(missing.length, SERVICE_CATALOG.length - 1);
});

test("findMissingCatalogServices: a renamed default is not seeded again", () => {
  /* Seeded rows keep their deterministic id forever, so a shop that
     renames one keeps the rename instead of getting the old name back. */
  const target = SERVICE_CATALOG[5];
  const renamed = [
    { serviceId: target.seedId, name: "Photocopy (B&W)", active: true },
  ];
  const missing = findMissingCatalogServices(renamed);
  assert.equal(missing.length, SERVICE_CATALOG.length - 1);
  assert.ok(!missing.some((m) => m.seedId === target.seedId));
  assert.ok(!missing.some((m) => m.name === target.name));
});

test("findMissingCatalogServices: a fully seeded shop needs no writes", () => {
  /* What ensureCatalogSeeded() sees the moment after the first run. */
  const seeded = SERVICE_CATALOG.map((e) => ({
    serviceId: e.seedId,
    name: e.name,
    active: true,
  }));
  assert.deepEqual(findMissingCatalogServices(seeded), []);
});

/* =========================================================
   Service picker (js/service-picker.js)
   -------------------------------------------------------------
   The picker is DOM code, but the parts that decide what the
   counter sees — grouping, filtering, tile text and keyboard
   movement — are pure and tested here.
   ========================================================= */

const PICKER_SERVICES = [
  { serviceId: "a1", name: "Passport Photo", code: "PP", pricePaise: 4000, sortOrder: 500, active: true },
  { serviceId: "a2", name: "Photocopy", code: "PC", pricePaise: 200, sortOrder: 100, active: true },
  { serviceId: "a3", name: "Laminating", code: "LA", pricePaise: 1000, sortOrder: 200, active: true },
  { serviceId: "a4", name: "Custom Binding", code: "CB", pricePaise: 0, sortOrder: 999, active: true },
  { serviceId: "a5", name: "Retired Job", code: "RJ", pricePaise: 500, sortOrder: 100, active: false },
];

/** Services as fetchServices() hands them over: only the active ones. */
const PICKER_ACTIVE = PICKER_SERVICES.filter((s) => s.active);

test("serviceMatchesQuery: matches on name, code and paise digits", () => {
  const photo = PICKER_SERVICES[0];
  assert.ok(serviceMatchesQuery(photo, "passport"), "name, case-insensitively");
  assert.ok(serviceMatchesQuery(photo, "  PP  "), "code, ignoring padding");
  assert.ok(serviceMatchesQuery(photo, "40"), "the rate as typed digits");
  assert.ok(serviceMatchesQuery(photo, "passport   photo"), "runs of spaces collapse");
  assert.ok(serviceMatchesQuery(photo, ""), "an empty query keeps everything");
  assert.ok(!serviceMatchesQuery(photo, "laminating"), "a different service");
  assert.ok(!serviceMatchesQuery(photo, "9999"), "no such digits");
});

test("serviceMatchesQuery: survives a junk service", () => {
  assert.ok(!serviceMatchesQuery(null, "photo"));
  assert.ok(!serviceMatchesQuery({}, "photo"));
  /* A numeric code and a non-numeric rate must not throw. */
  assert.ok(serviceMatchesQuery({ name: "Photo", code: 7, pricePaise: "abc" }, "photo"));
  assert.ok(!serviceMatchesQuery({ name: "Photo", code: 7, pricePaise: "abc" }, "laminate"));
  /* No name to find, but an empty query must still offer the row. */
  assert.ok(serviceMatchesQuery({}, ""));
});

test("serviceTile: uses the code, then the initials, then a fallback", () => {
  assert.equal(serviceTile({ name: "Photocopy", code: "PC" }), "PC");
  assert.equal(serviceTile({ name: "Black & White Photocopy" }), "BW");
  assert.equal(serviceTile({ name: "Aadhaar Card" }), "AC");
  /* One word gives one initial, not the first two letters. */
  assert.equal(serviceTile({ name: "Photo" }), "P");
  /* A hand-typed code is squashed, so no stray punctuation lands on a tile. */
  assert.equal(serviceTile({ name: "Photo", code: "A-VERY-LONG-CODE" }), "AV");
  assert.equal(serviceTile({ name: "Photo", code: "!!" }), "P", "an unusable code falls back to initials");
  /* A service the counter typed as "..." must not produce an empty tile. */
  assert.equal(serviceTile({ name: "!!!" }), "SV");
  assert.equal(serviceTile({}), "SV");
  assert.equal(serviceTile(null), "SV");
  assert.ok(serviceTile({ code: "1a2b3c" }).length <= 2, "tiles stay small");
});

test("serviceGroupOf: sortOrder bands map to the counter's sections", () => {
  const labelOf = (s) => serviceGroupOf(s).label;
  assert.equal(labelOf({ sortOrder: 100 }), SERVICE_CATALOG_GROUPS[0].label);
  assert.equal(labelOf({ sortOrder: 250 }), SERVICE_CATALOG_GROUPS[1].label);
  assert.equal(labelOf({ sortOrder: 300 }), SERVICE_CATALOG_GROUPS[2].label);
  assert.equal(labelOf({ sortOrder: 450 }), SERVICE_CATALOG_GROUPS[3].label);
  assert.equal(labelOf({ sortOrder: 599 }), SERVICE_CATALOG_GROUPS[4].label);
  /* Every seeded service lands in some real band, never the catch-all. */
  for (const entry of SERVICE_CATALOG) {
    assert.notEqual(labelOf(entry), "Other services", `seeded band exists: ${entry.name}`);
  }
  /* Hand-typed services land outside every band. */
  assert.equal(labelOf({ sortOrder: 999 }), "Other services");
  assert.equal(labelOf({}), "Other services");
  assert.equal(labelOf({ sortOrder: "junk" }), "Other services");
  assert.equal(labelOf(null), "Other services");
  /* A band's top edge belongs to the NEXT band, not this one. */
  assert.equal(labelOf({ sortOrder: 200 }), SERVICE_CATALOG_GROUPS[1].label);
  assert.equal(labelOf({ sortOrder: 199 }), SERVICE_CATALOG_GROUPS[0].label);
});

test("groupServices: hidden services are gone, sections are in order", () => {
  const groups = groupServices(PICKER_SERVICES);
  const labels = groups.map((g) => g.label);
  const band = (i) => SERVICE_CATALOG_GROUPS[i].label;
  assert.ok(!groups.some((g) => g.items.some((s) => s.serviceId === "a5")), "archived rows are filtered out");

  assert.ok(labels.indexOf(band(0)) >= 0, "the printing band is present");
  assert.ok(
    labels.indexOf(band(0)) < labels.indexOf(band(1)),
    "bands stay in catalog order"
  );
  assert.ok(
    labels.indexOf(band(1)) < labels.indexOf("Other services"),
    "the catch-all band is last, not first"
  );
  /* Only non-empty sections are rendered. */
  assert.ok(!labels.includes(band(2)), "an empty band is not shown");
});

test("groupServices: the order fetchServices() sent is kept inside a group", () => {
  /* fetchServices() sorts by sortOrder, which is the catalog's curated
     order; re-sorting by name here would scramble it. */
  const ordered = [
    { serviceId: "z", name: "Xerox", code: "XX", pricePaise: 0, sortOrder: 100, active: true },
    { serviceId: "y", name: "Aadhaar Print", code: "AP", pricePaise: 0, sortOrder: 110, active: true },
  ];
  const group = groupServices(ordered)[0];
  assert.deepEqual(group.items.map((s) => s.serviceId), ["z", "y"]);
});

test("groupServices: an empty catalog yields no groups", () => {
  assert.deepEqual(groupServices([]), []);
  assert.deepEqual(groupServices(null), []);
  assert.deepEqual(flattenOptions([]), []);
  assert.equal(countServiceRows([]), 0);
  assert.equal(countServiceRows(undefined), 0);
});

test("filterAndGroupServices: a search hides whole sections", () => {
  const groups = filterAndGroupServices(PICKER_ACTIVE, "photo");
  const items = groups.flatMap((g) => g.items).map((s) => s.serviceId);
  assert.deepEqual(items.sort(), ["a1", "a2"]);
  assert.ok(!groups.some((g) => g.label === "Photo services" && g.items.length === 0));
});

test("filterAndGroupServices: a no-match search keeps the other sections out", () => {
  const groups = filterAndGroupServices(PICKER_ACTIVE, "zzzz");
  assert.deepEqual(groups.flatMap((g) => g.items), []);
});

test("flattenOptions: headings and rows are in list order", () => {
  const rows = flattenOptions(groupServices(PICKER_SERVICES));
  const first = rows[0];
  assert.equal(first.type, "group", "a group opens with its heading");
  assert.ok(first.label, "a heading carries its label");
  assert.ok(!first.service, "a heading is not a service row");

  const services = rows.filter((r) => r.type === "service");
  assert.equal(countServiceRows(rows), services.length, "headings are not counted");
  assert.equal(services.length, PICKER_ACTIVE.length);
  assert.ok(services.every((r) => r.id && r.service), "every service row is selectable");
  assert.equal(rows.filter((r) => r.type === "group").length, groupServices(PICKER_SERVICES).length);
});

test("resultsSummary: counts read the way a shopkeeper would say them", () => {
  const rows = flattenOptions(groupServices(PICKER_SERVICES));
  assert.equal(resultsSummary(rows, ""), "4 services");
  assert.equal(resultsSummary([{ type: "service" }], ""), "1 service");
  assert.equal(resultsSummary([], ""), "No services yet");
  assert.equal(resultsSummary([], "  pccx  "), 'No match for "pccx"');
  assert.equal(resultsSummary([], ""), resultsSummary(undefined, null), "tolerates junk");
});

test("nextActiveIndex: arrows walk rows and skip the headings", () => {
  const rows = flattenOptions(groupServices(PICKER_SERVICES));
  /* The index is into the FLATTENED rows, headings included. */
  const at = (i) => (rows[i] && rows[i].type === "service" ? rows[i].id : null);
  const firstRow = rows.findIndex((r) => r.type === "service");
  const lastRow = rows.map((r) => r.type).lastIndexOf("service");

  assert.equal(nextActiveIndex(rows, -1, 1), firstRow, "ArrowDown takes the first row");
  assert.equal(at(nextActiveIndex(rows, rows.length, -1)), at(lastRow), "ArrowUp wraps to the last row");
  assert.equal(at(nextActiveIndex(rows, -1, 1)), at(firstRow), "ArrowDown past the end wraps to the first");
  assert.ok(at(nextActiveIndex(rows, firstRow, 1)), "stepping forward lands on a service, never a heading");
  assert.ok(at(nextActiveIndex(rows, lastRow, -1)), "stepping back lands on a service, never a heading");
  /* Two steps must move two services, even across a heading in between. */
  const second = nextActiveIndex(rows, nextActiveIndex(rows, firstRow, 1), 1);
  assert.notEqual(second, firstRow, "ArrowDown actually advances");
  assert.equal(nextActiveIndex([], -1, 1), -1, "an empty list has nowhere to go");
  assert.equal(nextActiveIndex(null, -1, 1), -1);
  /* A list of nothing but headings has nothing to highlight. */
  assert.equal(nextActiveIndex([{ type: "group" }], -1, 1), -1);
});

test("fixedPlacementCorrection: a transformed ancestor must not shift the menu", () => {
  /* The dialog animates in with a transform, which makes it the containing
     block for the viewport-pinned menu. The list must still land under the
     field, not beside it. */
  const wantLeft = 220;
  const wantTop = 300;
  for (const ancestorOffset of [0, 180, -40, 61.5]) {
    /* Told position = want, so it renders at ancestorOffset + want. */
    const gotLeft = ancestorOffset + wantLeft;
    const gotTop = ancestorOffset + wantTop;
    const fix = fixedPlacementCorrection(wantLeft, wantTop, gotLeft, gotTop);
    if (ancestorOffset === 0) {
      /* No transform, no correction — nothing to undo. */
      assert.equal(fix, null, "an untransformed ancestor needs no correction");
      continue;
    }
    assert.ok(fix, `an offset of ${ancestorOffset} must be corrected`);
    /* Feeding the corrected values back in must now land on the target. */
    assert.ok(
      Math.abs(ancestorOffset + fix.left - wantLeft) <= 1,
      `left lands on target (offset ${ancestorOffset})`
    );
    assert.ok(
      Math.abs(ancestorOffset + fix.top - wantTop) <= 1,
      `top lands on target (offset ${ancestorOffset})`
    );
  }
});

test("fixedPlacementCorrection: no correction when the first try was right", () => {
  assert.equal(fixedPlacementCorrection(220, 300, 220, 300), null);
  /* Sub-pixel jitter is not worth a second style write. */
  assert.equal(fixedPlacementCorrection(220, 300, 220.4, 299.6), null);
  /* One axis off is still a correction. */
  assert.deepEqual(fixedPlacementCorrection(220, 300, 220, 260), { left: 220, top: 340 });
});

/* =========================================================
   The day head.

   A business day is one document whose counters are advanced in the same
   atomic batch as each sale, and firestore.rules re-checks on every write
   that the head moved by exactly that sale. So this arithmetic is not
   cosmetic: if it drifts, sales stop being recordable, and if it is
   wrong in the permissive direction the day's totals are wrong.
   ========================================================= */

const COUNTER_MAX = 100000000000000; // mirrors the rules' field range

/**
 * A line-by-line mirror of the `countersOk` rule in firestore.rules, so
 * the client-side check can be held to the server's contract.
 */
function rulesCountersOk(c) {
  if (!c || typeof c !== "object") return false;
  const allowed = new Set([
    "txnCount",
    "grossPaise",
    "cashPaise",
    "upiPaise",
    "cardPaise",
    "duePaise",
    "collectedPaise",
  ]);
  for (const key of Object.keys(c)) if (!allowed.has(key)) return false;
  for (const field of allowed) {
    const v = c[field];
    if (v === undefined) continue; // the rules' hasOnly tolerates a subset
    if (!Number.isInteger(v) || v < 0 || v > COUNTER_MAX) return false;
  }
  const g = c.grossPaise ?? 0;
  const parts = (c.cashPaise ?? 0) + (c.upiPaise ?? 0) + (c.cardPaise ?? 0) + (c.duePaise ?? 0);
  if (g !== parts) return false;
  if ((c.collectedPaise ?? 0) !== g - (c.duePaise ?? 0)) return false;
  return true;
}

test("emptyCounters: a new day is a valid, all-zero day", () => {
  const c = emptyCounters();
  assert.deepEqual(Object.keys(c).sort(), [...COUNTER_FIELDS].sort(), "exactly the fields the rules pin");
  assert.ok(isCounterSetValid(c), "an untouched day still satisfies the rules' invariant");
  assert.equal(c.txnCount, 0);
  assert.equal(c.grossPaise, 0);
  assert.equal(c.collectedPaise, 0);
  /* A fresh object every call, so a caller cannot poison the next day. */
  emptyCounters().grossPaise = 999;
  assert.equal(emptyCounters().grossPaise, 0);
});

test("splitAmounts: a sale lands in exactly one bucket, and only due is uncollected", () => {
  for (const method of ["cash", "upi", "card", "due"]) {
    const a = splitAmounts(12345, method);
    const buckets = [a.cash, a.upi, a.card, a.due];
    assert.equal(a.gross, 12345, "gross is the sale total");
    assert.equal(
      buckets.reduce((s, v) => s + v, 0),
      a.gross,
      "the four buckets add up to the gross"
    );
    assert.equal(buckets.filter((v) => v > 0).length, 1, "only one bucket is non-zero");
    assert.equal(a[method], a.gross, `the ${method} bucket carries the sale`);
    if (method === "due") {
      assert.equal(a.collected, 0, "a due sale has not been collected");
    } else {
      assert.equal(a.collected, a.gross, "a settled sale is collected in full");
    }
  }
});

test("splitAmounts: a zero-rupee sale is still a sale", () => {
  const a = splitAmounts(0, "upi");
  assert.equal(a.gross, 0);
  assert.equal(a.collected, 0);
  /* The count is the counter that says a sale happened; the money split
     being empty must not make the day look unsold. */
  const stepped = stepCounters(emptyCounters(), a, 1);
  assert.equal(stepped.txnCount, 1);
  assert.ok(isCounterSetValid(stepped));
});

test("splitAmounts: an unknown method is refused rather than silently worth nothing", () => {
  /* Silently returning all zeros would let a sale be recorded while
     contributing nothing to its day — the exact failure the head exists
     to make impossible. */
  for (const bad of ["bank", "", null, undefined, 0, "CASH", "Cash"]) {
    assert.throws(
      () => splitAmounts(500, bad),
      Error,
      `method ${JSON.stringify(bad)} must not produce a sale split`
    );
  }
});

test("isCounterSetValid: agrees with the firestore.rules invariant", () => {
  /* Both must give the same answer for any well-formed counter set, or
     the client will either distrust a good day or trust a bad one. */
  const cases = [
    emptyCounters(),
    stepCounters(emptyCounters(), splitAmounts(50000, "cash"), 1),
    stepCounters(emptyCounters(), splitAmounts(50000, "due"), 1),
    /* Buckets that do not add up to the gross. */
    { ...emptyCounters(), txnCount: 1, grossPaise: 100, cashPaise: 40 },
    /* Collected disagreeing with the gross minus due. */
    { ...emptyCounters(), txnCount: 1, grossPaise: 100, cashPaise: 100, collectedPaise: 50 },
    /* A negative count. */
    { ...emptyCounters(), txnCount: -1 },
    /* A fractional paise count. */
    { ...emptyCounters(), grossPaise: 10.5 },
    /* Past the rules' ceiling. */
    { ...emptyCounters(), grossPaise: COUNTER_MAX + 1 },
    /* An unexpected field the rules would not allow. */
    { ...emptyCounters(), surprise: 1 },
  ];
  for (const c of cases) {
    assert.equal(
      isCounterSetValid(c),
      rulesCountersOk(c),
      `client and rules must agree on ${JSON.stringify(c)}`
    );
  }
});

test("isCounterSetValid: the client is deliberately stricter than the rules on a missing field", () => {
  /* The rules' keys().hasOnly() tolerates an absent counter and reads it
     as zero, which is fine for them because the field is pinned on every
     write. A head read back with one missing is not something to show a
     shopkeeper as a day's takings, so the client refuses it. */
  const partial = { ...emptyCounters() };
  delete partial.cardPaise;
  assert.equal(rulesCountersOk(partial), true, "the rules would accept this");
  assert.equal(isCounterSetValid(partial), false, "the client refuses it and folds the rows instead");
});

test("isCounterSetValid: rubbish in, false out — never a crash", () => {
  for (const bad of [null, undefined, 0, "", "nope", [], NaN, true]) {
    assert.equal(isCounterSetValid(bad), false, `${JSON.stringify(bad)} is not a counter set`);
  }
});

test("stepCounters: a sale and its reversal land the day back where it started", () => {
  /* This is the property the rules exploit: an edit writes the difference,
     and a delete writes the negative. If a step were not exactly
     reversible the day would drift a little on every correction. */
  for (const method of ["cash", "upi", "card", "due"]) {
    for (const total of [0, 1, 499, 100000, 99999999]) {
      const before = emptyCounters();
      const amounts = splitAmounts(total, method);
      const after = stepCounters(before, amounts, 1);
      const back = stepCounters(after, amounts, -1);
      assert.deepEqual(back, before, `${method} ${total} must reverse exactly`);
    }
  }
});

test("stepCounters: does not mutate the day it was given", () => {
  const before = stepCounters(emptyCounters(), splitAmounts(1000, "cash"), 1);
  const snapshot = { ...before };
  stepCounters(before, splitAmounts(70000, "upi"), 1);
  assert.deepEqual(before, snapshot, "a sale must not edit the caller's copy of the day");
});

test("a whole day of sales keeps the head consistent and the total honest", () => {
  /* Walk a realistic day and check the head after every single sale, the
     way the rules check it after every single write. */
  const sales = [
    ["cash", 2, 5000],
    ["upi", 1, 100000],
    ["due", 3, 25000],
    ["card", 1, 129900],
    ["due", 1, 75000],
    ["cash", 5, 1200],
    ["upi", 2, 4999],
  ];

  let head = emptyCounters();
  let expectedGross = 0;
  let expectedCollected = 0;
  let expectedDue = 0;

  for (const [method, qty, ratePaise] of sales) {
    const totalPaise = qty * ratePaise;
    head = stepCounters(head, splitAmounts(totalPaise, method), 1);
    expectedGross += totalPaise;
    if (method === "due") expectedDue += totalPaise;
    else expectedCollected += totalPaise;

    assert.ok(
      isCounterSetValid(head),
      `the head must satisfy the rules after a ${method} sale: ${JSON.stringify(head)}`
    );
  }

  assert.equal(head.txnCount, sales.length, "every sale counted once");
  assert.equal(head.grossPaise, expectedGross, "the day's gross is the sum of its sales");
  assert.equal(head.collectedPaise, expectedCollected, "collected is everything not still owed");
  assert.equal(head.duePaise, expectedDue, "what is owed is tracked on its own");
  assert.equal(head.collectedPaise + head.duePaise, head.grossPaise, "collected and owed cover the gross");
});

test("amountsFromDoc: prefers the stored split, re-splits a document that predates it", () => {
  /* A sale written with the split, exactly as the current code stores it. */
  const modern = { total: 5000, paymentMethod: "upi", amounts: splitAmounts(5000, "upi") };
  assert.deepEqual(amountsFromDoc(modern), splitAmounts(5000, "upi"));

  /* A sale from before the split existed: the total is still there, so
     the contribution can be recovered under the document's OWN method
     rather than whatever bucket the caller happened to default to. */
  for (const method of ["cash", "upi", "card", "due"]) {
    const legacy = { total: 5000, paymentMethod: method };
    assert.deepEqual(
      amountsFromDoc(legacy),
      splitAmounts(5000, method),
      `a legacy ${method} sale must be recovered as ${method}`
    );
  }

  /* A stored split wins over the fallback, even when they disagree — it
     is what the day's counters were actually advanced by. */
  const drifted = { total: 9999, paymentMethod: "cash", amounts: splitAmounts(5000, "upi") };
  assert.deepEqual(amountsFromDoc(drifted), splitAmounts(5000, "upi"));

  /* An explicit override still applies when a caller really means it. */
  assert.deepEqual(amountsFromDoc({ total: 5000, paymentMethod: "upi" }, "card"), splitAmounts(5000, "card"));

  /* A stored split is read defensively: junk in one bucket must not
     become NaN and poison the day. */
  const junk = { total: 5000, paymentMethod: "upi", amounts: { gross: 5000, cash: "x", upi: null, card: 0, due: 0, collected: 0 } };
  assert.deepEqual(amountsFromDoc(junk), { gross: 5000, cash: 0, upi: 0, card: 0, due: 0, collected: 0 });

  /* An unreadable method is recovered as cash rather than throwing, so
     a shopkeeper can still fix or delete a malformed row. */
  const broken = { total: 5000, paymentMethod: "cheque" };
  assert.deepEqual(amountsFromDoc(broken), splitAmounts(5000, "cash"));

  /* Nothing to recover at all still gives a zero contribution. */
  assert.deepEqual(amountsFromDoc(null), splitAmounts(0, "cash"));
});

test("the day state names are frozen, so a rule and a client cannot drift apart", () => {
  assert.ok(Object.isFrozen(DAY_STATE), "DAY_STATE must not be editable at runtime");
  assert.deepEqual(Object.values(DAY_STATE).sort(), ["closed", "open"]);
  assert.ok(Object.isFrozen(COUNTER_FIELDS), "COUNTER_FIELDS must not be editable at runtime");
});

/* =========================================================
   Day integrity (read-only)
   -----------------------------------------------------------------
   firestore.rules only ever lets a sale move a day head by
   exactly one sale's worth, in that sale's direction. A head that
   has stopped agreeing with its sales therefore freezes every edit,
   settle and delete on that day — and the shop is told nothing more
   than "not allowed to change this sale".

   The usual cause is a sale deleted straight from the Firestore
   console: no counters move with it, and the head keeps its money.
   These tests pin down that the check names such a day, names the
   field that is wrong, and never guesses a value for a sale the
   rules cannot read at all.
   ========================================================= */

/** A stored sale document in the shape firestore.rules pins. */
function storedSale(txnId, totalPaise, method) {
  return {
    txnId,
    total: totalPaise,
    paymentMethod: method,
    amounts: splitAmounts(totalPaise, method),
  };
}

/** A day head that has been kept correctly in step with `sales`. */
function headFor(sales) {
  return sales.reduce((c, s) => stepCounters(c, amountsFromDoc(s), 1), emptyCounters());
}

test("AUDIT_FIELDS names exactly the counters the rules pin", () => {
  /* A counter added to COUNTER_FIELDS and not to AUDIT_FIELDS would
     silently vanish from every drift report, which is the one place
     it must never be able to do. */
  assert.deepEqual(AUDIT_FIELDS.map((f) => f.field), [...COUNTER_FIELDS]);
  assert.ok(Object.isFrozen(AUDIT_FIELDS), "the report's field list must not be editable");
  assert.ok(Object.isFrozen(AUDIT_STATUS), "the verdict names must not be editable");
});

test("sumDayCounters adds a day's sales the way the head was advanced", () => {
  const sales = [
    storedSale("t1", 10000, "cash"),
    storedSale("t2", 25000, "upi"),
    storedSale("t3", 40000, "due"),
    storedSale("t4", 1500, "card"),
  ];

  const sum = sumDayCounters(sales);
  assert.equal(sum.saleCount, 4);
  assert.deepEqual(sum.unreadable, [], "every modern sale is readable");
  assert.deepEqual(
    sum.counters,
    headFor(sales),
    "the sum must be indistinguishable from a head the rules would accept",
  );
  assert.ok(isCounterSetValid(sum.counters));
});

test("auditDayCounters: a head that adds up to its sales is in step", () => {
  const sales = [storedSale("t1", 10000, "cash"), storedSale("t2", 40000, "due")];
  const audit = auditDayCounters({
    dateKey: "2026-10-02",
    head: { state: DAY_STATE.OPEN, counters: headFor(sales) },
    rows: sales,
  });

  assert.equal(audit.status, AUDIT_STATUS.OK);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.drift, [], "nothing to report when nothing is wrong");
  assert.equal(describeAudit(audit).tone, "ok");
});

test("auditDayCounters: a sale deleted outside the app leaves the head stranded", () => {
  /* The day as it was recorded... */
  const recorded = [storedSale("t1", 10000, "cash"), storedSale("t2", 25000, "upi")];
  const head = headFor(recorded);

  /* ...and the day as it is now: t2 is gone from the console, so the head
     still carries its money. The head is not merely wrong, it is a
     perfectly VALID counter set — which is exactly why nothing on screen
     ever looked broken. */
  assert.ok(isCounterSetValid(head), "a stranded head still satisfies the rules' own invariant");

  const audit = auditDayCounters({
    dateKey: "2026-10-02",
    head: { state: DAY_STATE.OPEN, counters: head },
    rows: [recorded[0]],
  });

  assert.equal(audit.status, AUDIT_STATUS.DRIFTED);
  assert.equal(audit.saleCount, 1, "one sale is really there");

  const byField = Object.fromEntries(audit.drift.map((d) => [d.field, d]));
  assert.equal(byField.txnCount.delta, -1, "the head counts a sale that is not there");
  assert.equal(byField.grossPaise.delta, -25000, "and its money with it");
  assert.equal(byField.upiPaise.delta, -25000, "in the bucket it was paid into");
  assert.equal(byField.cashPaise, undefined, "a field that agrees is not reported");

  /* The arithmetic to put it right is trivial, which is exactly why the
     repair needs a deliberate rule of its own: no rule allows a step
     bigger than one sale. */
  assert.equal(
    isCounterSetValid(stepCounters(head, amountsFromDoc(recorded[1]), -1)),
    true,
  );
});

test("auditDayCounters: the verdict does not depend on whether the day is open", () => {
  /* A closed day refuses writes for its own reason. A stranded head
     refuses them whatever the state says, so the check must not let the
     state colour the answer — otherwise a shop is pointed at "the day is
     closed" when reopening it will change nothing. */
  const sales = [storedSale("t1", 10000, "cash")];
  const head = headFor([...sales, storedSale("t2", 99900, "card")]);

  const open = auditDayCounters({ dateKey: "2026-10-02", head: { state: DAY_STATE.OPEN, counters: head }, rows: sales });
  const closed = auditDayCounters({ dateKey: "2026-10-02", head: { state: DAY_STATE.CLOSED, counters: head }, rows: sales });

  assert.equal(open.status, AUDIT_STATUS.DRIFTED);
  assert.equal(closed.status, AUDIT_STATUS.DRIFTED);
  assert.equal(closed.state, DAY_STATE.CLOSED, "the state is still reported for the shop");
  assert.deepEqual(open.drift, closed.drift);
});

test("auditDayCounters: a sale the rules cannot read is named, never guessed at", () => {
  /* A document written before the per-method split. The client can still
     read it (amountsFromDoc falls back to the row's own total and method)
     but firestore.rules reads resource.data.amounts.gross when deleting
     one, which ERRORS rather than answering — so that row can never be
     deleted, however healthy the head is. */
  const legacy = { txnId: "old1", total: 7000, paymentMethod: "cash" };
  const sales = [storedSale("t1", 10000, "cash")];

  const audit = auditDayCounters({
    dateKey: "2026-10-02",
    head: { state: DAY_STATE.OPEN, counters: headFor(sales) },
    rows: [...sales, legacy],
  });

  assert.equal(audit.status, AUDIT_STATUS.UNREADABLE);
  assert.deepEqual(
    audit.unreadable,
    [{ txnId: "old1", why: "it carries no amounts map" }],
    "the row is named with the reason, so it can be looked at",
  );
  assert.equal(audit.saleCount, 2, "the day's sale count is the truth, not the readable subset");

  const said = describeAudit(audit);
  assert.equal(said.tone, "error");
  assert.ok(said.detail.includes("old1"), "the report has to point at the row: " + said.detail);
});

test("auditDayCounters: a day with sales and no head at all", () => {
  const orphan = auditDayCounters({
    dateKey: "2026-10-02",
    head: null,
    rows: [storedSale("t1", 10000, "cash")],
  });
  assert.equal(orphan.status, AUDIT_STATUS.NO_HEAD);
  assert.ok(describeAudit(orphan).detail.includes("Every write to it is refused"));

  const neverOpened = auditDayCounters({ dateKey: "2026-10-03", head: null, rows: [] });
  assert.equal(neverOpened.status, AUDIT_STATUS.NO_HEAD);
  assert.ok(
    describeAudit(neverOpened).detail.includes("nothing to check"),
    "a day that was never opened is not a fault: " + describeAudit(neverOpened).detail,
  );
});

test("auditDayCounters: a head whose own counters are broken", () => {
  /* Buckets that do not add up to the gross. Nothing can be written
     against such a head, so this is called out ahead of any drift. */
  const audit = auditDayCounters({
    dateKey: "2026-10-02",
    head: {
      state: DAY_STATE.OPEN,
      counters: {
        txnCount: 2,
        grossPaise: 35000,
        cashPaise: 10000,
        upiPaise: 10000,
        cardPaise: 10000,
        duePaise: 0,
        collectedPaise: 30000,
      },
    },
    rows: [storedSale("t1", 10000, "cash")],
  });

  assert.equal(audit.status, AUDIT_STATUS.BAD_HEAD);
  assert.equal(describeAudit(audit).tone, "error");
});

test("auditDayCounters: a read that stopped short draws no conclusion", () => {
  const sales = [storedSale("t1", 10000, "cash")];
  const audit = auditDayCounters({
    dateKey: "2026-10-02",
    /* A head for far more sales than came back. Reporting that as drift
       would be a lie: the missing rows are simply unread. */
    head: {
      state: DAY_STATE.OPEN,
      counters: headFor([...sales, storedSale("t2", 40000, "upi"), storedSale("t3", 90000, "card")]),
    },
    rows: sales,
    truncated: true,
  });

  assert.equal(audit.status, AUDIT_STATUS.INCOMPLETE);
  assert.equal(audit.ok, false, "no verdict is not a pass");
  assert.equal(describeAudit(audit).tone, "warning");
});

test("describeAudit says what is wrong instead of blaming a closed day", () => {
  const sales = [storedSale("t1", 10000, "cash")];
  const audit = auditDayCounters({
    dateKey: "2026-10-02",
    head: { state: DAY_STATE.OPEN, counters: headFor([...sales, storedSale("t2", 25000, "upi")]) },
    rows: sales,
  });

  const said = describeAudit(audit);
  assert.equal(said.tone, "error");
  assert.ok(said.headline.includes("2026-10-02"), "the day is named: " + said.headline);
  assert.ok(said.detail.includes("gross"), "the field is named: " + said.detail);
  assert.ok(
    !said.detail.toLowerCase().includes("closed"),
    "a stranded head is not a closed day, and saying so sends the shop the wrong way",
  );
});

test("auditDayCounters survives rubbish, because a diagnostic that crashes is useless", () => {
  const audit = auditDayCounters({
    dateKey: "2026-10-02",
    head: { state: DAY_STATE.OPEN, counters: { txnCount: "two", grossPaise: null } },
    rows: [null, undefined, storedSale("t1", 10000, "cash")],
  });

  assert.equal(audit.status, AUDIT_STATUS.BAD_HEAD);
  assert.equal(audit.saleCount, 1, "holes in the list are skipped, and the real sale still counts");
  assert.deepEqual(audit.unreadable, [], "a hole is not a malformed sale, so it is not named as one");
  assert.equal(typeof describeAudit(audit).detail, "string");
});

/* =========================================================
   A sale the client can read and the rules cannot
   -----------------------------------------------------------------
   amountsFromDoc() fills an absent bucket with 0, so a document
   written before the per-method split still adds up on the client
   and the day's totals can be perfectly in step.

   firestore.rules has no such patience. headSteppedBy() reads
   `a.cash` by name, and on a document without that key the engine
   RAISES rather than answering false: the evaluation errors and the
   whole batch is refused. A delete cannot happen, an edit cannot
   happen, and no repair of the head will change it, because the
   head is not what is wrong.

   This is the case the first version of this check could not see,
   because it summed rows with the client's tolerant reader — so it
   agreed with the write path and disagreed with the rules, and
   reported a day whose every sale was undeletable as "in step".
   ========================================================= */

test("amountsRulesCannotUse names what the rules would choke on", () => {
  assert.equal(amountsRulesCannotUse(storedSale("t1", 10000, "cash")), null, "a modern sale is fine");

  /* The whole point: the client reads this happily. */
  const legacy = { txnId: "old1", total: 10000, paymentMethod: "cash", amounts: { gross: 10000, cash: 10000 } };
  assert.deepEqual(amountsFromDoc(legacy), { gross: 10000, cash: 10000, upi: 0, card: 0, due: 0, collected: 0 });
  assert.match(amountsRulesCannotUse(legacy), /missing upi, card, due, collected/);

  /* `is int` in the rules. A string does not merely compare unequal —
     multiplying it by a step is not an operation the language has. */
  const asText = storedSale("t2", 10000, "cash");
  asText.amounts = { ...asText.amounts, cash: "10000" };
  assert.match(amountsRulesCannotUse(asText), /not whole paise: cash/);

  assert.match(amountsRulesCannotUse({ txnId: "x", total: 5, paymentMethod: "cash" }), /no amounts map/);
  assert.match(amountsRulesCannotUse({ txnId: "x", amounts: 7 }), /no amounts map/);
  assert.ok(typeof amountsRulesCannotUse(null) === "string", "a missing document is reported, not thrown on");
});

test("a day of legacy sales reads as in step to the client and unusable to the rules", () => {
  /* Three sales, every one missing the later buckets — the shape a
     build older than the per-method split left behind. */
  const legacy = [10000, 25000, 40000].map((total, i) => ({
    txnId: "old" + i,
    total,
    paymentMethod: "cash",
    amounts: { gross: total, cash: total },
  }));

  /* What the client believes, and what it would compute for the head. */
  const clientSum = headFor(legacy);
  assert.equal(clientSum.txnCount, 3);
  assert.equal(clientSum.grossPaise, 75000);

  /* So the head is in step, and the old check said so: nothing to do. */
  const trusting = auditDayCounters({
    dateKey: "2026-10-03",
    head: { state: DAY_STATE.OPEN, counters: clientSum },
    rows: legacy.map((d) => ({ ...d, amounts: { ...d.amounts, upi: 0, card: 0, due: 0, collected: 0 } })),
  });
  assert.equal(trusting.status, AUDIT_STATUS.OK, "with the fields filled in, the day is genuinely fine");

  /* The real documents are refused, and the report has to say so. */
  const audit = auditDayCounters({
    dateKey: "2026-10-03",
    head: { state: DAY_STATE.OPEN, counters: clientSum },
    rows: legacy,
  });
  assert.equal(audit.status, AUDIT_STATUS.UNREADABLE);
  assert.equal(audit.unreadable.length, 3, "every sale on the day is affected, not just one");

  /* And no repair of the head is offered, because the head is right. */
  const plan = planDayRepair(audit);
  assert.equal(plan.status, REPAIR_STATUS.UNUSABLE);
  assert.equal(plan.repairable, false, "writing the head cannot free a document the rules cannot read");

  /* The refusal the shop sees must not send them to repair a head that
     is already correct. */
  const said = describeRefusal(audit, plan);
  assert.match(said, /2026-10-03/);
  assert.match(said, /not a head out of step/i, "the usual explanation is ruled out in words, not left implied");
  assert.ok(!/put it back in one step/i.test(said), "nothing here is repairable, so nothing may promise a repair");
  assert.match(said, /old0/, "the sale itself is named, because that is what has to be looked at");
  assert.match(describeAudit(audit).detail, /missing/, "and the missing field is named");
});

/* =========================================================
   Putting a stranded day back in step
   -----------------------------------------------------------------
   firestore.rules' head rule (boundedCounterStep) already accepts
   a bounded move on its own: a sale count that shifts by no more
   than one, money within HEAD_MONEY_STEP per field, and an
   after-set that still adds up. One phantom sale is exactly that
   size, so the commonest drift can be undone WITHOUT a rule
   change and without touching a sale.

   These tests hold that line in two places: the bound must keep
   matching the rules file, and the plan must refuse everything the
   bound would not accept, rather than forcing a correction through.
   ========================================================= */

/** The head of a day one phantom cash sale taller than its real sales. */
function strandedHead(sales, phantom) {
  return { state: DAY_STATE.OPEN, counters: stepCounters(headFor(sales), amountsFromDoc(phantom), 1) };
}

test("the client's copy of the rules' head bound still matches firestore.rules", () => {
  const rules = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
  const bound = rules.match(/function boundedCounterStep[\s\S]*?\n      \}/);
  assert.ok(bound, "boundedCounterStep must still exist in firestore.rules");

  /* The money limit is written out in full in every comparison — two per
     money field, one for each direction. If the rules' ceiling is ever
     raised, this fails and the client is corrected with it — rather than
     the app quietly offering repairs the rules will refuse. */
  const steps = (bound[0].match(/100000000000/g) || []).length;
  assert.equal(steps, 12, "all six money fields are still bounded in both directions, by one ceiling");
  assert.equal(HEAD_MONEY_STEP, 100000000000, "the client's ceiling must be the rules' ceiling");
  assert.equal(HEAD_COUNT_STEP, 1, "the rules still allow a head to move by one sale, not two");
  assert.match(bound[0], /after\.txnCount == before\.txnCount - 1/, "a head may still lose one sale");
  assert.match(bound[0], /countersOk\(after\)/, "the rules judge the destination, not the journey");
});

test("counterStepAllowed mirrors the rules: one sale, a valid destination", () => {
  const before = headFor([storedSale("t1", 10000, "cash"), storedSale("t2", 25000, "upi")]);

  assert.ok(counterStepAllowed(before, headFor([storedSale("t1", 10000, "cash")])), "one sale out");
  assert.ok(
    counterStepAllowed(before, stepCounters(before, amountsFromDoc(storedSale("t3", 1, "card")), 1)),
    "one sale in",
  );
  assert.ok(counterStepAllowed(before, before), "no change at all");

  /* Losing the last sale leaves an empty day, which is a legitimate
     destination — losing two is not a move the rules recognise. */
  const oneSale = headFor([storedSale("t1", 10000, "cash")]);
  assert.ok(counterStepAllowed(oneSale, emptyCounters()), "an empty day is a legitimate destination");
  assert.equal(counterStepAllowed(before, emptyCounters()), false, "but not two sales in one write");

  /* Two phantom sales is one move too many, and that refusal is the
     whole reason the app stops here instead of correcting the day. */
  const twoOut = emptyCounters();
  assert.equal(counterStepAllowed(before, twoOut), false, "two sales out is refused");
  assert.equal(
    counterStepAllowed(before, { ...before, txnCount: before.txnCount + 2 }),
    false,
    "a count two higher is refused",
  );
  assert.equal(
    counterStepAllowed(before, { ...before, grossPaise: before.grossPaise + HEAD_MONEY_STEP + 1 }),
    false,
    "money past the ceiling is refused",
  );
  assert.equal(
    counterStepAllowed(before, { ...before, grossPaise: before.grossPaise + 100, cashPaise: 0 }),
    false,
    "a destination whose buckets no longer add up is refused",
  );
  assert.equal(counterStepAllowed(before, null), false);
});

test("planDayRepair offers a repair for a head one phantom sale too tall", () => {
  const sales = [storedSale("t1", 10000, "cash"), storedSale("t2", 25000, "upi")];
  const phantom = storedSale("gone", 5000, "cash");
  const audit = auditDayCounters({ dateKey: "2026-10-02", head: strandedHead(sales, phantom), rows: sales });

  assert.equal(audit.status, AUDIT_STATUS.DRIFTED, "the day is the case this exists for");
  const plan = planDayRepair(audit);
  assert.equal(plan.status, REPAIR_STATUS.READY);
  assert.equal(plan.repairable, true);

  /* The counters to write are the report's own numbers, not a second
     derivation of them: two sums could disagree, and then the screen
     would promise one thing and write another. */
  assert.deepEqual(plan.target, audit.actualCounters);
  assert.deepEqual(plan.target, headFor(sales));
  assert.equal(plan.steps.length > 0, true);
  assert.match(plan.reason, /one phantom sale/);
});

test("a repaired head is one the rules would accept from the head it has", () => {
  const sales = [storedSale("t1", 10000, "cash"), storedSale("t2", 40000, "due")];
  const head = strandedHead(sales, storedSale("gone", 7000, "card"));
  const plan = planDayRepair(auditDayCounters({ dateKey: "2026-10-02", head, rows: sales }));

  assert.equal(plan.repairable, true);
  assert.ok(
    counterStepAllowed(head.counters, plan.target),
    "the repair must fit boundedCounterStep, or the write is refused and the shop is told nothing",
  );
});

test("planDayRepair refuses everything it cannot do, and says which", () => {
  const sales = [storedSale("t1", 10000, "cash"), storedSale("t2", 25000, "upi")];

  const inStep = planDayRepair(
    auditDayCounters({ dateKey: "2026-10-02", head: { state: DAY_STATE.OPEN, counters: headFor(sales) }, rows: sales })
  );
  assert.equal(inStep.status, REPAIR_STATUS.NOT_NEEDED);
  assert.equal(inStep.repairable, false, "a healthy day is never offered a repair");

  /* Two phantom sales: real, and beyond what one bounded write may do. */
  const twoGone = stepCounters(
    headFor(sales),
    amountsFromDoc(storedSale("g1", 1000, "cash")),
    1
  );
  twoGone.txnCount += 1;
  twoGone.grossPaise += 1000;
  twoGone.cashPaise += 1000;
  twoGone.collectedPaise += 1000;
  const wide = planDayRepair(
    auditDayCounters({
      dateKey: "2026-10-02",
      head: { state: DAY_STATE.OPEN, counters: twoGone },
      rows: sales,
    })
  );
  assert.equal(wide.status, REPAIR_STATUS.TOO_LARGE);
  assert.equal(wide.repairable, false, "the app must not widen the rules to finish the job");
  assert.match(wide.reason, /person to look/);

  /* A closed head's counters are frozen by the close and reopen rules
     both, which pin them unchanged. Reported, not worked around. */
  const closed = planDayRepair(
    auditDayCounters({
      dateKey: "2026-10-02",
      head: { state: DAY_STATE.CLOSED, counters: strandedHead(sales, storedSale("gone", 5000, "cash")).counters },
      rows: sales,
    })
  );
  assert.equal(closed.status, REPAIR_STATUS.CLOSED);
  assert.match(closed.reason, /reopen the day/i);

  const noHead = planDayRepair(
    auditDayCounters({ dateKey: "2026-10-02", head: null, rows: sales })
  );
  assert.equal(noHead.status, REPAIR_STATUS.NO_HEAD);

  /* Writing a total that leaves out a sale the rules cannot read
     would be a new kind of wrong, so there is nothing to write. */
  const unreadable = planDayRepair(
    auditDayCounters({
      dateKey: "2026-10-02",
      head: { state: DAY_STATE.OPEN, counters: headFor(sales) },
      rows: [storedSale("t1", 10000, "cash"), { txnId: "old", total: 25000, paymentMethod: "upi" }],
    })
  );
  assert.equal(unreadable.status, REPAIR_STATUS.UNUSABLE);
  assert.equal(unreadable.repairable, false);

  const partial = planDayRepair(
    auditDayCounters({
      dateKey: "2026-10-02",
      head: { state: DAY_STATE.OPEN, counters: strandedHead(sales, storedSale("gone", 5000, "cash")) },
      rows: sales,
      truncated: true,
    })
  );
  assert.equal(partial.status, REPAIR_STATUS.UNUSABLE);
  assert.equal(partial.repairable, false, "a partial sum is not a total to write");

  for (const plan of [inStep, wide, closed, noHead, unreadable, partial]) {
    assert.equal(plan.target, null, "nothing refused may hand back counters to write");
    assert.equal(typeof plan.reason, "string");
    assert.ok(plan.reason.length > 0, "a refusal has to explain itself");
  }
});

test("a corrupt head is judged by the bound, not by its label", () => {
  /* boundedCounterStep never inspects where the counters came from, so
     a head that is not even a valid counter set can still be written
     back to one that is — provided the move is sale-sized. Labelling
     it "bad head" and stopping there would leave the day frozen. */
  const sales = [storedSale("t1", 10000, "cash"), storedSale("t2", 25000, "upi")];
  const broken = { txnCount: 4, grossPaise: 99999, cashPaise: 1, upiPaise: 0, cardPaise: 0, duePaise: 0, collectedPaise: 0 };
  const audit = auditDayCounters({ dateKey: "2026-10-02", head: { state: DAY_STATE.OPEN, counters: broken }, rows: sales });
  assert.equal(audit.status, AUDIT_STATUS.BAD_HEAD);

  const nearEnough = { ...broken, txnCount: 3 };
  const plan = planDayRepair(
    auditDayCounters({ dateKey: "2026-10-02", head: { state: DAY_STATE.OPEN, counters: nearEnough }, rows: sales })
  );
  assert.equal(plan.status, REPAIR_STATUS.READY);
  assert.deepEqual(plan.target, headFor(sales));
  assert.ok(counterStepAllowed(nearEnough, plan.target));

  const farOff = planDayRepair(
    auditDayCounters({ dateKey: "2026-10-02", head: { state: DAY_STATE.OPEN, counters: broken }, rows: sales })
  );
  assert.equal(farOff.repairable, false, "a count that cannot be walked back one sale at a time is not ours to fix");
});

test("planDayRepair survives rubbish and a missing report", () => {
  for (const bad of [null, undefined, {}, 0, "nope"]) {
    const plan = planDayRepair(bad);
    assert.equal(typeof plan.reason, "string");
    assert.equal(plan.repairable, false, "an unreadable report must never authorise a write");
  }
  assert.ok(Object.isFrozen(REPAIR_STATUS));
});

test("a refused write is told its cause, and each cause leads somewhere else", () => {
  const sales = [storedSale("t1", 10000, "cash"), storedSale("t2", 25000, "upi")];
  const oneGone = auditDayCounters({
    dateKey: "2026-10-02",
    head: strandedHead(sales, storedSale("gone", 5000, "cash")),
    rows: sales,
  });

  const repairable = describeRefusal(oneGone);
  assert.match(repairable, /2026-10-02/, "the day is named, so the shop knows which day is stuck");
  assert.match(repairable, /put it back in one step/i, "and is told the ledger can fix this one itself");

  const manyGone = auditDayCounters({
    dateKey: "2026-10-03",
    head: { state: DAY_STATE.OPEN, counters: { ...headFor(sales), txnCount: 9, grossPaise: 90000, cashPaise: 90000, collectedPaise: 90000 } },
    rows: sales,
  });
  const notRepairable = describeRefusal(manyGone);
  assert.match(notRepairable, /2026-10-03/);
  assert.match(
    notRepairable,
    /show the difference in full/i,
    "a gap too wide to fix must not be described as fixable",
  );

  /* The most valuable sentence of the lot: the usual explanation does
     not apply, so the shop stops looking for a closed day. */
  const healthy = auditDayCounters({
    dateKey: "2026-10-04",
    head: { state: DAY_STATE.OPEN, counters: headFor(sales) },
    rows: sales,
  });
  const inStep = describeRefusal(healthy);
  assert.match(inStep, /do\s+add up/i);
  assert.ok(
    !/Day integrity card/.test(inStep),
    "there is nothing to repair on a healthy day, so it must not send anyone to the repair",
  );

  /* A sale the rules cannot read is named, and no head repair is offered
     as a way out of it — the head is not what is wrong. */
  const unreadable = describeRefusal(
    auditDayCounters({
      dateKey: "2026-10-05",
      head: { state: DAY_STATE.OPEN, counters: headFor(sales) },
      rows: [{ txnId: "old-1", total: 25000, paymentMethod: "upi" }],
    })
  );
  assert.match(unreadable, /2026-10-05/);
  assert.ok(!/put it back in one step/i.test(unreadable), "a backfill is not a head repair");

  const noHead = describeRefusal(
    auditDayCounters({ dateKey: "2026-10-06", head: null, rows: sales })
  );
  assert.match(noHead, /No day head/i);

  for (const said of [repairable, notRepairable, inStep, unreadable, noHead]) {
    assert.ok(said.length > 40, "a refusal has to say enough to act on: " + said);
    assert.match(said, /2026-10-0[2-6]/, "every one of these names the day it is about");
  }

  /* A plan is derived when not handed over, so the two cannot be quoted
     out of step with each other. */
  assert.equal(describeRefusal(oneGone), describeRefusal(oneGone, planDayRepair(oneGone)));
});

test("every refused change in txn-actions.js is told its cause, not just reported", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "txn-actions.js"), "utf8");

  /* Edit, settle and delete all refuse writes the same way. A bare
     describeWriteError() left in any of them would hand the shop the
     old "not allowed" with no day and no difference — the one sentence
     that has already failed this shop twice. */
  for (const stale of ["toast(describeWriteError(", "showEditError(describeWriteError("]) {
    assert.equal(src.includes(stale), false, "no refusal may bypass the diagnosis: " + stale);
  }
  const uses = src.match(/await describeRefusedWrite\(/g) || [];
  assert.equal(uses.length, 3, "edit, settle and delete each diagnose: found " + uses.length);

  /* The diagnosis reads the whole day. Adding up the rows the table
     happens to be showing would name a difference that is only a
     pagination artefact. */
  assert.match(src, /fetchTransactions\(\{ dateKey, limit: DIAGNOSIS_ROW_LIMIT \}\)/);
  assert.match(src, /rows\.length >= DIAGNOSIS_ROW_LIMIT/);

  /* A diagnosis that throws must never replace the error the shop was
     actually shown. */
  assert.match(src, /console\.error\("\[trustx-ledger\] refusal diagnosis:"[\s\S]*?return null;/);
  assert.match(src, /if \(!found\) return plain;/);
});

/* =========================================================
   Free-plan survival kit
   -----------------------------------------------------------------
   The shop is on Firebase's Spark plan: 50,000 reads, 20,000 writes and
   20,000 deletes a DAY, with nothing behind it to warn of them coming.
   Two things guard that wall — a classifier that recognises the refusal,
   and a cache so repeat views never pay for the same read twice. Both are
   tested here because both fail silently when they are wrong: a
   mis-classified quota error reaches the shop as "try again" (and the
   sale is lost), and a cache that does not serve hits is just a bug
   nobody notices until the 50,000th read.
   ========================================================= */

test("isQuotaExhausted recognises the Spark daily wall, and only that wall", () => {
  /* Matched on the code, which is what the SDK actually sets. */
  assert.equal(isQuotaExhausted({ code: "resource-exhausted" }), true);
  /* And on the namespaced form newer builds may use. */
  assert.equal(isQuotaExhausted({ code: "firestore/resource-exhausted" }), true);
  assert.equal(isQuotaExhausted({ code: "RESOURCE_EXHAUSTED" }), true);

  /* The documented message, as a fallback only. */
  assert.equal(
    isQuotaExhausted({
      code: "unknown",
      message: "This database has exceeded their daily quota, please retry with exponential backoff.",
    }),
    true
  );

  /* The errors that must NOT be softened into "try later". A dropped
     connection recovers by itself; a quota refusal never does, and telling
     the shop to retry is what loses the sale. */
  assert.equal(isQuotaExhausted({ code: "unavailable" }), false);
  assert.equal(isQuotaExhausted({ code: "permission-denied" }), false);
  assert.equal(isQuotaExhausted({ code: "auth/network-request-failed" }), false);
  assert.equal(isQuotaExhausted({ code: "not-found" }), false);
  assert.equal(isQuotaExhausted({ code: "deadline-exceeded" }), false);

  /* The client's own validation errors are plain Errors with no code and
     must never be mistaken for a server-side wall. */
  assert.equal(isQuotaExhausted(new Error("Choose a service for this sale.")), false);
  assert.equal(isQuotaExhausted(new Error("Enter a valid rate (₹0 or more).")), false);
  assert.equal(isQuotaExhausted(null), false);
  assert.equal(isQuotaExhausted(undefined), false);

  /* A code that merely CONTAINS the words must not match, or an unrelated
     error could be misread as a wall. */
  assert.equal(isQuotaExhausted({ code: "resource-exhausted-but-not-really" }), false);
});

test("readsForQuery counts the rules' grant lookup, not just the documents", () => {
  /* A query returning N docs costs about N+1: Firestore bills a minimum of
     one read per query, and firestore.rules gates every collection behind
     trusted(), which itself costs a get(accessGrants/{uid}). Omitting that
     +1 is what would let the meter flatter the app by ~40% on a history
     walk, which is precisely the read pattern that hits the wall. */
  assert.equal(readsForQuery(0), 1, "a zero-result query is still billed one read");
  assert.equal(readsForQuery(1), 2);
  assert.equal(readsForQuery(121), 122);
  assert.equal(readsForQuery(200), 201);

  /* Defensive: a missing snapshot must not read as free. */
  assert.equal(readsForQuery(undefined), 1);
  assert.equal(readsForQuery(null), 1);
});

test("the Spark limits the app guards against are the documented ones", () => {
  /* Pinned so a plan change in the console is a deliberate edit here,
     not a silent drift between what the meter promises and the wall. */
  assert.deepEqual(SPARK_LIMITS, { readsPerDay: 50000, writesPerDay: 20000, deletesPerDay: 20000 });
  assert.ok(Object.isFrozen(SPARK_LIMITS), "the limits must not be editable at runtime");
});

test("quotaResetTime lands in the afternoon in India, because that is when it is", () => {
  /* Firestore resets around midnight Pacific, which is roughly 12:30-1:30pm
     in India: mid-afternoon on a working day. The shop is told a time, so
     the time has to be an India one. */
  const when = quotaResetTime(new Date("2026-09-24T06:00:00Z"));
  assert.match(String(when), /^\d{1,2}:\d{2}\s?(am|pm)$/);

  /* No formatter must not throw — this is called from a catch path. */
  assert.doesNotThrow(() => quotaResetTime(new Date("2026-09-24T06:00:00Z")));
});

test("the read cache serves a fresh value instead of paying for it twice", async () => {
  let calls = 0;
  const cache = createReadCache({ freshTtlMs: 60_000, staleTtlMs: 600_000 });

  const loader = async () => {
    calls += 1;
    return { n: calls };
  };

  /* First call is a miss: the caller waits for the server. */
  const first = await cache.read("k", loader);
  assert.deepEqual(first, { n: 1 });
  assert.equal(calls, 1);

  /* Every call inside serveTtl is served from memory. Ten page loads in a
     minute must not cost ten reads — this is the whole point. */
  for (let i = 0; i < 10; i += 1) {
    assert.deepEqual(await cache.read("k", loader), { n: 1 });
  }
  assert.equal(calls, 1, "a served-from-cache read must not reach the server");
});

test("a failed load is never cached, so the next read tries again", async () => {
  let calls = 0;
  const cache = createReadCache({ freshTtlMs: 60_000, staleTtlMs: 600_000 });
  const loader = async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient");
    return { n: calls };
  };

  /* The failure propagates to the caller rather than becoming a value. */
  await assert.rejects(() => cache.read("k", loader), /transient/);

  /* And it left no poisoned entry behind: a reader that swallowed the
     error must not then be served `undefined` for the rest of the session. */
  assert.deepEqual(await cache.read("k", loader), { n: 2 });
});

test("the write paths' escape hatch really bypasses the cache", async () => {
  let calls = 0;
  const cache = createReadCache({ freshTtlMs: 60_000, staleTtlMs: 600_000 });
  const loader = async () => {
    calls += 1;
    return { n: calls };
  };

  await cache.read("head", loader);
  assert.equal(calls, 1);

  /* A sale must never verify its day head against a cached one. */
  const fresh = await cache.read("head", loader, { force: true });
  assert.deepEqual(fresh, { n: 2 });
  assert.equal(calls, 2);
});

test("dropping a key forgets exactly that key", async () => {
  let calls = 0;
  const cache = createReadCache({ freshTtlMs: 60_000, staleTtlMs: 600_000 });
  const loader = async () => {
    calls += 1;
    return { n: calls };
  };

  await cache.read("a", loader);
  await cache.read("b", loader);
  assert.equal(calls, 2);

  cache.drop("a");
  await cache.read("a", loader);
  assert.equal(calls, 3, "the dropped key must be re-read");

await cache.read("b", loader);
  assert.equal(calls, 3, "the other key must be untouched");
});

test("dropPrefix forgets a whole family of keys, not just one", async () => {
  let calls = 0;
  const cache = createReadCache({ freshTtlMs: 60_000, staleTtlMs: 600_000 });
  const loader = async () => {
    calls += 1;
    return { n: calls };
  };

  /* The shape of the real row cache: one day, many page sizes. A sale
     invalidates all of them at once, and it must not take a new page size
     appearing to invalidate correctly. */
  await cache.read("day:2026-09-24:100", loader);
  await cache.read("day:2026-09-24:200", loader);
  await cache.read("day:2026-09-25:100", loader);
  await cache.read("txns:2026-09-24:300", loader);
  assert.equal(calls, 4);

  /* Writing to the 24th forgets only the 24th. */
  cache.dropPrefix("day:2026-09-24:");
  await cache.read("day:2026-09-24:100", loader);
  await cache.read("day:2026-09-24:200", loader);
  await cache.read("day:2026-09-25:100", loader);
  await cache.read("txns:2026-09-24:300", loader);
  assert.equal(calls, 6, "both page sizes of the written day must be re-read");

  /* A different prefix still misses only what it names. */
  cache.dropPrefix("txns:2026-09-24:");
  await cache.read("txns:2026-09-24:300", loader);
  assert.equal(calls, 7);

  /* An unknown prefix is harmless — writes must not have to know every key
     that exists to be safe. */
  assert.doesNotThrow(() => cache.dropPrefix("nothing-matches-this:"));
});

test("the cache hands the same value to concurrent readers", async () => {
  let calls = 0;
  const cache = createReadCache({ freshTtlMs: 60_000, staleTtlMs: 600_000 });

  /* Two screens opening at once (dashboard and ledger in parallel tabs, or
     a page that renders a summary and a count together) must not each start
     their own request. */
  const loader = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return { n: calls };
  };

  const [a, b, c] = await Promise.all([
    cache.read("k", loader),
    cache.read("k", loader),
    cache.read("k", loader),
  ]);

  assert.equal(calls, 1, "concurrent callers must share one request");
  assert.deepEqual(a, { n: 1 });
  assert.deepEqual(b, { n: 1 });
  assert.deepEqual(c, { n: 1 });
});

test("a cached value goes stale in the background without blocking the page", async () => {
  let calls = 0;
  /* Wide margins on purpose: these tests assert WHICH branch of the TTL
     logic runs, so the gaps between steps are far larger than the jitter of
     a busy test runner. A tight boundary here would make this test fail
     occasionally and teach nobody anything. */
  const cache = createReadCache({ freshTtlMs: 100, staleTtlMs: 1000 });
  const loader = async () => {
    calls += 1;
    return { n: calls };
  };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  /* Let any background re-check actually finish rather than guessing. */
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 1));
  };

  assert.deepEqual(await cache.read("k", loader), { n: 1 });
  assert.equal(calls, 1);

  /* Inside the fresh window: served with no request at all. This is the
     common case — the same screen reopened a few times in a row. */
  assert.deepEqual(await cache.read("k", loader), { n: 1 });
  assert.equal(calls, 1, "a fresh value must not cost a read");

  /* Past the fresh window but still inside the stale window the reader gets
     the old value AT ONCE — the shop sees today's total rather than a
     spinner — and the re-check happens off to the side. */
  await tick(200);
  assert.deepEqual(await cache.read("k", loader), { n: 1 });
  assert.equal(calls, 2, "the re-check should have started in the background");

  /* Once it lands, the next reader is served the corrected value. */
  await settle();
  assert.deepEqual(await cache.read("k", loader), { n: 2 });

  /* Past the stale window the caller waits for the server again rather than
     being shown something arbitrarily old. */
  await tick(1200);
  assert.deepEqual(await cache.read("k", loader), { n: 3 });
});

test("a rejected background refresh does not poison a good cached value", async () => {
  let calls = 0;
  const cache = createReadCache({ freshTtlMs: 100, staleTtlMs: 1000 });
  const loader = async () => {
    calls += 1;
    if (calls === 2) throw new Error("re-check refused");
    return { n: calls };
  };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 1));
  };

  assert.deepEqual(await cache.read("k", loader), { n: 1 });

  /* A read past the fresh window starts a re-check, and that re-check
     fails. */
  await tick(200);
  assert.deepEqual(await cache.read("k", loader), { n: 1 });
  await settle();
  assert.equal(calls, 2, "the failing re-check should have happened");

  /* The failure must not have replaced the good value with a rejected
     promise or an undefined: the shop keeps seeing its last known totals,
     rather than a screen that empties itself over a re-check nobody asked
     for. */
  assert.deepEqual(await cache.read("k", loader), { n: 1 });

  /* That read also started the retry, because the failure left the entry at
     its old age. So the re-check can still succeed: the shop sees the
     corrected total, having never seen a blank or a broken screen. */
  await settle();
  assert.deepEqual(await cache.read("k", loader), { n: 3 });
});

test("a read that races a write cannot resurrect the pre-write value", async () => {
  let calls = 0;
  const cache = createReadCache({ freshTtlMs: 1000, staleTtlMs: 5000 });
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const loader = async () => {
    calls += 1;
    if (calls === 1) {
      await gate;
      return { n: 1 };
    }
    return { n: calls };
  };

  /* A read goes out, and while it is still open a sale lands and
     invalidates everything it touches. */
  const inFlight = cache.read("head:2026-09-24", loader);
  await new Promise((r) => setTimeout(r, 5));
  cache.dropPrefix("head:2026-09-24:");
  release();

  /* The in-flight read still answers its own caller — it cannot be
     un-called — but it must NOT be stored. */
  assert.deepEqual(await inFlight, { n: 1 });
  assert.deepEqual(await cache.read("head:2026-09-24", loader), { n: 2 });
  assert.equal(calls, 2, "the invalidated answer must not have been reused");

  /* Otherwise the dashboard would show a total that does not include the
     sale the shopkeeper just made, for the whole TTL. */
});

/* =========================================================
   Surviving the page load
   -----------------------------------------------------------------
   These screens are separate HTML documents, so a module-scoped Map is
   thrown away by every navigation and every refresh. Without the persisted
   layer the all-time history walk — the most expensive read in the app —
   would be bought again in full each time, which is the exact opposite of
   what the cache is for.
   ========================================================= */

/** A minimal localStorage, since the module under test needs one. */
function installFakeStorage() {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    key(i) {
      return [...data.keys()][i] ?? null;
    },
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    _data: data,
  };
}

/* Async on purpose: the caller awaits inside the callback, and a plain
   try/finally wrapper would restore localStorage the moment that callback
   returned its promise — i.e. before any of the reads below had run. */
async function withFakeStorage(fn) {
  const previous = globalThis.localStorage;
  const fake = installFakeStorage();
  globalThis.localStorage = fake;
  try {
    return await fn(fake);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

test("a persisted value is served after the page is reloaded", async () => {
  await withFakeStorage(async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { rows: [{ id: "a" }, { id: "b" }] };
    };

    /* The "first page load": a real read. */
    const before = createReadCache({ freshTtlMs: 100, staleTtlMs: 100_000, persist: "history" });
    assert.deepEqual(await before.read("txns:all:200", loader), { rows: [{ id: "a" }, { id: "b" }] });
    assert.equal(calls, 1);

    /* The "reload": a brand new cache over the same storage, which is all a
       page navigation leaves behind. */
    const after = createReadCache({ freshTtlMs: 100, staleTtlMs: 100_000, persist: "history" });
    assert.deepEqual(await after.read("txns:all:200", loader), { rows: [{ id: "a" }, { id: "b" }] });
    assert.equal(calls, 1, "the reload must not have paid for the walk again");
  });
});

test("a persisted value past the stale window is not served", async () => {
  await withFakeStorage(async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { n: calls };
    };

    const first = createReadCache({ freshTtlMs: 50, staleTtlMs: 150, persist: "history" });
    assert.deepEqual(await first.read("k", loader), { n: 1 });

    /* Well past the stale window: the saved copy is no longer an answer,
       so the new page must ask the server rather than show stale rows as
       if they were current. */
    await new Promise((r) => setTimeout(r, 250));
    const reloaded = createReadCache({ freshTtlMs: 50, staleTtlMs: 150, persist: "history" });
    assert.deepEqual(await reloaded.read("k", loader), { n: 2 });
    assert.equal(calls, 2);
  });
});

test("invalidating a persisted key clears it for the next page load too", async () => {
  await withFakeStorage(async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { n: calls };
    };

    const first = createReadCache({ freshTtlMs: 100_000, staleTtlMs: 100_000, persist: "history" });
    await first.read("txns:all:200", loader);
    assert.equal(calls, 1);

    /* A sale lands. The memory copy goes, and so must the persisted one —
       otherwise the next page load would serve history from before it. */
    first.dropPrefix("txns:all:");

    const reloaded = createReadCache({ freshTtlMs: 100_000, staleTtlMs: 100_000, persist: "history" });
    assert.deepEqual(await reloaded.read("txns:all:200", loader), { n: 2 });
    assert.equal(calls, 2);
  });
});

test("persisted namespaces are separate and never touch other storage", async () => {
  await withFakeStorage(async (storage) => {
    const loader = async () => ({ v: "x" });

    const history = createReadCache({ freshTtlMs: 100_000, staleTtlMs: 100_000, persist: "history" });
    const expenses = createReadCache({ freshTtlMs: 100_000, staleTtlMs: 100_000, persist: "expenses" });
    await history.read("k", loader);
    await expenses.read("k", loader);

    storage.setItem("unrelated-app-key", "keep me");

    /* Dropping one namespace entirely must not empty the other, and must
       not reach past its own prefix into the rest of localStorage. */
    history.drop();
    assert.equal(storage.getItem("unrelated-app-key"), "keep me");

    const expensesAfter = createReadCache({ freshTtlMs: 100_000, staleTtlMs: 100_000, persist: "expenses" });
    let expensesCalls = 0;
    assert.deepEqual(
      await expensesAfter.read("k", async () => {
        expensesCalls += 1;
        return { v: "x" };
      }),
      { v: "x" },
    );
    assert.equal(expensesCalls, 0, "the other namespace should have survived");
  });
});

test("a cache without storage is simply a cache, and never throws", async () => {
  /* The persisted layer must never be load-bearing: a browser with storage
     disabled, or a full disk, has to behave exactly as before. */
  const boom = {
    length: 0,
    key: () => null,
    getItem: () => {
      throw new Error("storage disabled");
    },
    setItem: () => {
      throw new Error("storage disabled");
    },
    removeItem: () => {},
  };
  const previous = globalThis.localStorage;
  globalThis.localStorage = boom;
  try {
    let calls = 0;
    const cache = createReadCache({ freshTtlMs: 100_000, staleTtlMs: 100_000, persist: "history" });
    const loader = async () => {
      calls += 1;
      return { n: calls };
    };
    assert.deepEqual(await cache.read("k", loader), { n: 1 });
    assert.deepEqual(await cache.read("k", loader), { n: 1 });
    assert.equal(calls, 1);
    assert.doesNotThrow(() => cache.drop("k"));
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

/* =========================================================
   A row must know which day it belongs to.

   `dateKey` lives on the PARENT dayHeads document, never on the sale itself,
   so `...raw` in normalizeTxn cannot supply it. Every write path is addressed
   by (dateKey, txnId): deleteTransaction, updateTransaction and
   markTransactionPaid all begin with isValidDateKey(dateKey) and throw
   "That business day is not valid." otherwise.

   When normalizeTxn dropped that argument, deleting a sale failed before it
   ever reached Firestore � a dead button and a rules layer that was never
   consulted. Nothing else in the app noticed, because every other consumer of
   a row (totals, filters, labels) reads fields the sale really does carry.

   normalizeTxn is not exported, so it is lifted out of js/ledger.js verbatim
   and exercised with the same helpers that module has in scope. That keeps the
   test honest about the shipping implementation instead of a copy of it.
   ========================================================= */

function loadNormalizeTxn() {
  const src = fs.readFileSync(path.join(ROOT, "js", "ledger.js"), "utf8");
  const start = src.indexOf("function normalizeTxn(");
  const end = src.indexOf("\nfunction normalizeExpense(");
  assert.notEqual(start, -1, "js/ledger.js should still define normalizeTxn()");
  assert.notEqual(end, -1, "could not find the end of normalizeTxn()");

  /* Resolved from ROOT, not hardcoded: the harness below is re-imported as a
     data: URL, which cannot resolve a bare relative specifier, so the one
     import it needs has to be absolute — and "absolute" here has to mean
     absolute on whichever machine the repo is checked out on. */
  const utilsUrl = pathToFileURL(path.join(ROOT, "js", "utils.js")).href;
  const preamble = [
    `import { isPaymentMethod, methodLabel } from ${JSON.stringify(utilsUrl)};`,
    "function toSafe(value) {",
    '  const n = typeof value === "number" ? value : Number(value);',
    "  return Number.isFinite(n) ? n : 0;",
    "}",
    "function toPaiseInt(value) { return Math.max(0, Math.round(toSafe(value))); }",
    "",
  ].join("\n");

  return import(
    "data:text/javascript," +
      encodeURIComponent(preamble + src.slice(start, end) + "\nexport { normalizeTxn };\n")
  ).then((m) => m.normalizeTxn);
}

/* A sale exactly as firestore.rules has it on disk � note the absence of any
   dateKey field, which is the whole point. */
const STORED_SALE = {
  txnId: "abc123",
  serviceId: "svc_print",
  serviceName: "Photocopy",
  quantity: 2,
  rate: 5000,
  total: 10000,
  paymentMethod: "cash",
  status: "paid",
  amounts: { gross: 10000, cash: 10000, upi: 0, card: 0, due: 0, collected: 10000 },
  customerName: "Asha",
  createdBy: "u1",
  updatedBy: "u1",
};

test("a day row carries the dateKey its write paths require", async () => {
  const normalizeTxn = await loadNormalizeTxn();

  const row = normalizeTxn("abc123", { ...STORED_SALE }, "2026-10-01");

  assert.equal(
    row.dateKey,
    "2026-10-01",
    "the row must carry the day it was read from",
  );
  assert.ok(
    isValidDateKey(row.dateKey),
    "deleteTransaction/updateTransaction/markTransactionPaid all refuse an " +
      "invalid dateKey, so a row without a usable one cannot be written at all",
  );
});

test("a row's dateKey comes from the caller, never from the sale document", async () => {
  const normalizeTxn = await loadNormalizeTxn();

  /* A legacy or hand-edited document carrying a stale dateKey must not be able
     to redirect a write to the wrong day � the day the row was actually READ
     from is the only trustworthy answer. */
  const row = normalizeTxn("abc123", { ...STORED_SALE, dateKey: "1999-01-01" }, "2026-10-01");
  assert.equal(row.dateKey, "2026-10-01", "a stored dateKey must not shadow the real day");
});

test("every place that builds a row passes the day it already knows", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "ledger.js"), "utf8");

  /* The all-time history walk reads each day's subcollection in turn, so it
     must pass THAT head's id rather than one shared variable. */
  assert.match(
    src,
    /normalizeTxn\(doc\.id,\s*doc\.data\(\),\s*head\.id\)/,
    "the history walk must pass head.id, or every historical row is unaddressable",
  );

  /* The three single-day readers all have `dateKey` in scope. */
  const singleDay = [...src.matchAll(/normalizeTxn\(\s*\w+\.id,\s*\w+\.data\(\)\s*\)/g)];
  assert.deepEqual(
    singleDay.map((m) => m[0]),
    [],
    "every normalizeTxn call must be given the day it read from",
  );
});

/* ---------------- The receipt photograph ---------------- */

/* One real JPEG's worth of base64 is not needed to test a length: the decoder
   only counts characters, and the rules only count characters. */
const b64 = (n) => "A".repeat(n);

test("a receipt's size is read from its base64 payload, not guessed", () => {
  /* 4 base64 characters carry 3 bytes, padding included. */
  assert.equal(receiptImageBytes(RECEIPT_IMAGE_PREFIX + b64(4)), 3);
  assert.equal(receiptImageBytes(RECEIPT_IMAGE_PREFIX + b64(400)), 300);
  /* Two padding characters mean the last group carried a single byte. */
  assert.equal(receiptImageBytes(RECEIPT_IMAGE_PREFIX + b64(3) + "="), 2);
  assert.equal(receiptImageBytes(RECEIPT_IMAGE_PREFIX + b64(3) + "=="), 1);
});

test("anything that is not a JPEG data URL has no size", () => {
  /* A photo that cannot be counted cannot be checked against the ceiling, so
     it is refused rather than stored and found out about later. That refusal
     is null, not zero: zero is a real, storable size. */
  assert.equal(receiptImageBytes(null), null);
  assert.equal(receiptImageBytes(""), null);
  assert.equal(receiptImageBytes("hello"), null);
  assert.equal(receiptImageBytes("data:image/png;base64,AAAA"), null);
  assert.equal(receiptImageBytes(RECEIPT_IMAGE_PREFIX), null);
  /* Padding belongs at the very end and nowhere else. */
  assert.equal(receiptImageBytes(RECEIPT_IMAGE_PREFIX + "A=AA"), null);
  /* Characters outside the base64 alphabet are not a picture. */
  assert.equal(receiptImageBytes(RECEIPT_IMAGE_PREFIX + "AA*A"), null);
});

test("a photo is storable only while it fits the Firestore document ceiling", () => {
  /* base64 carries 3 bytes per 4 characters, so the payload length that
     decodes to exactly the ceiling. */
  const atCeiling = RECEIPT_IMAGE_PREFIX + b64(Math.ceil((RECEIPT_IMAGE_MAX_BYTES * 4) / 3));
  assert.equal(receiptImageBytes(atCeiling), RECEIPT_IMAGE_MAX_BYTES);
  assert.ok(
    isStorableReceiptImage(atCeiling),
    "a picture at the ceiling must be accepted, or the encoder and the rules disagree",
  );

  /* One byte over: a longer payload, because the count is of DECODED bytes.
     Base64 grows by 4/3, so the encoded form is what has to stay inside a
     1 MiB document - which is why the client counts decoded bytes and the
     rules count the encoded string. */
  const overBy = RECEIPT_IMAGE_PREFIX + b64(Math.ceil(((RECEIPT_IMAGE_MAX_BYTES + 1) * 4) / 3));
  assert.equal(isStorableReceiptImage(overBy), false);

  /* And the base64 of the ceiling itself has to leave room for the rest of
     the document: 4/3 of 600 KB is ~800 KB, inside Firestore's 1 MiB. */
  const encoded = RECEIPT_IMAGE_PREFIX.length + Math.ceil((RECEIPT_IMAGE_MAX_BYTES * 4) / 3);
  assert.ok(encoded <= 900000, `a maximum-size receipt encodes to ${encoded} characters`);

  assert.equal(isStorableReceiptImage(""), false);
  assert.equal(isStorableReceiptImage(undefined), false);
});

test("a row says whether its sale has a photograph, so the day's read stays small", async () => {
  const normalizeTxn = await loadNormalizeTxn();

  /* The marker is the only thing a listing of the day ever reads; the picture
     itself is fetched only when someone asks to see it. */
  assert.equal(normalizeTxn("abc123", { ...STORED_SALE, hasReceipt: true }, "2026-10-01").hasReceipt, true);
  assert.equal(normalizeTxn("abc123", { ...STORED_SALE, hasReceipt: false }, "2026-10-01").hasReceipt, false);
  /* A sale recorded before photographs were kept has no marker at all, and
     that must read as "none" rather than as undefined. */
  assert.equal(normalizeTxn("abc123", { ...STORED_SALE }, "2026-10-01").hasReceipt, false);
  assert.equal(
    normalizeTxn("abc123", { ...STORED_SALE, hasReceipt: "yes" }, "2026-10-01").hasReceipt,
    false,
    "only a real boolean counts as having a receipt",
  );
});

test("the sale is written before its photograph, because that is what the rules read", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "ledger.js"), "utf8");
  const block = src.slice(src.indexOf("export async function createTransaction"));

  const saleAt = block.indexOf("batch.set(txnRef(");
  const photoAt = block.indexOf("receiptImageRef(");
  assert.ok(saleAt > -1 && photoAt > -1, "createTransaction writes both documents");
  assert.ok(
    saleAt < photoAt,
    "the rules let a photo exist only for a sale that existsAfter, and a " +
      "document in a batch is visible only to the writes after it",
  );
});

test("a photo is fetched with the same (txnId, dateKey) order as every other sale call", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "ledger.js"), "utf8");
  const actions = fs.readFileSync(path.join(ROOT, "js", "txn-actions.js"), "utf8");

  /* Every other sale-shaped call in this module takes the id first
     (deleteTransaction, updateTransaction, markTransactionPaid), and this one
     silently returns null instead of throwing if the two are swapped — which
     is exactly the kind of mistake that survives a test suite. */
  const fn = src.slice(src.indexOf("export async function fetchReceiptImage"));
  assert.match(
    fn.slice(0, fn.indexOf("{")),
    /fetchReceiptImage\(txnId, dateKey\)/,
    "fetchReceiptImage must take (txnId, dateKey)",
  );
  assert.match(
    actions,
    /fetchReceiptImage\(row\.txnId, row\.dateKey\)/,
    "the receipt viewer must pass the sale id first",
  );
});
