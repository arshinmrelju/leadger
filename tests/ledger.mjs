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
