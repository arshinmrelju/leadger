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
} from "../js/day-heads.js";

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
  for (const expected of ["printing", "government", "online", "photo", "dtp"]) {
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
