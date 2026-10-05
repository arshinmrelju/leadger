/* =========================================================
   Receipt line items: every line of a bill, and an unknown name
   that is a question rather than a refusal.
   -----------------------------------------------------------------
   Two failures are being pinned down here, and both were silent:

   1. A bill is a LIST. The Gemini prompt used to ask for the
      "largest / primary line item" of a multi-line receipt, so a
      three-line bill booked ONE sale and two lines of real money
      never reached the ledger. These tests read whole receipts and
      assert every line survives, footers and all.

   2. A name the shop has never catalogued used to end in "Choose a
      service to record the sale against" — with the reading thrown
      away. rankCatalogMatches() is now tested for the other half of
      its answer: not a silent near-match, but the name plus the
      closest services to choose from.

   The last test is a source guard on the prompt itself, because that
   instruction is the bug: pure functions cannot catch a prompt that
   asks the model to summarise a list away.
   ========================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_SCANNED_ITEMS,
  clampScanRupees,
  cleanScanName,
  parseReceiptLines,
  normalizeScanItems,
  scanItemPaise,
  scanItemsTotal,
  rankCatalogMatches,
} from "../js/receipt-items.js";

import { MAX_RATE_PAISE, MAX_TOTAL_PAISE, MAX_QUANTITY } from "../js/utils.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A stand-in for the shop's catalog: what rankCatalogMatches reads. */
const CATALOG = [
  { serviceId: "s1", name: "A4 Photocopy", pricePaise: 400, sortOrder: 110 },
  { serviceId: "s2", name: "Passport Photo", pricePaise: 10000, sortOrder: 120 },
  { serviceId: "s3", name: "Spiral Binding", pricePaise: 4000, sortOrder: 130 },
  { serviceId: "s4", name: "Lamination", pricePaise: 1000, sortOrder: 140 },
  { serviceId: "s5", name: "Photocopy / Print / Colour", pricePaise: 800, sortOrder: 150 },
  { serviceId: "s6", name: "Old Service", pricePaise: 500, sortOrder: 160, active: false },
];

/* ---------------- Amounts ---------------- */

test("a scanned amount is bounded by the same ceilings the write path enforces", () => {
  assert.equal(clampScanRupees("4"), 4);
  assert.equal(clampScanRupees(4.005), 4.01, "rounded to paise, never a third decimal");
  assert.equal(clampScanRupees("249.50"), 249.5);

  /* A misread digit must not arrive at the rules as a denial. */
  assert.equal(clampScanRupees(-1), null, "a negative amount is not an amount");
  assert.equal(clampScanRupees(MAX_RATE_PAISE / 100 + 1, MAX_RATE_PAISE), null);
  assert.equal(clampScanRupees(MAX_TOTAL_PAISE / 100 + 1, MAX_TOTAL_PAISE), null);
  assert.equal(clampScanRupees(MAX_TOTAL_PAISE / 100, MAX_TOTAL_PAISE), MAX_TOTAL_PAISE / 100);
  assert.equal(clampScanRupees("abc"), null);
  assert.equal(clampScanRupees(null), null);
  assert.equal(clampScanRupees(""), null);
});

test("a name off a bill loses the count and the punctuation around it", () => {
  assert.equal(cleanScanName("2 x A4 Photocopy"), "A4 Photocopy");
  assert.equal(cleanScanName("  Spiral   Binding  "), "Spiral Binding");
  assert.equal(cleanScanName("- Laminate A4 -"), "Laminate A4");
  assert.equal(cleanScanName("Passport Photo x3"), "Passport Photo");
  assert.equal(cleanScanName("A4 Photocopy".repeat(30)).length, 80, "the catalog's own name limit");
  assert.equal(cleanScanName(null), "");
});

/* ---------------- Reading a whole bill ---------------- */

test("every line of a bill is read, not just the biggest", () => {
  /* The shape this app was built for: three real lines, a subtotal,
     tax, and a footer. */
  const receipt = [
    "TRUSTX DIGITAL SOLUTIONS",
    "GSTIN: 29ABCDE1234F1Z5",
    "01/10/2026  11:42 AM",
    "A4 Photocopy          4.00      20.00",
    "Passport Photo        100.00    100.00",
    "Spiral Binding        40.00     110.00",
    "Sub Total                     230.00",
    "CGST 9%                      10.35",
    "Total                        240.35",
    "UPI                           240.35",
    "Thank you, visit again",
  ].join("\n");

  const items = parseReceiptLines(receipt);
  assert.equal(items.length, 3, "three lines sold means three lines read");

  assert.deepEqual(
    items.map((i) => i.serviceName),
    ["A4 Photocopy", "Passport Photo", "Spiral Binding"],
  );
  assert.deepEqual(items.map((i) => i.quantity), [1, 1, 1]);
  assert.deepEqual(items.map((i) => i.totalRupees), [20, 100, 110]);
});

test("a printed count is the quantity, and is not also read as money", () => {
  const items = parseReceiptLines(
    ["2 x A4 Photocopy      4.00      20.00", "Spiral Binding x2   40.00      110.00"].join("\n"),
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].quantity, 2);
  assert.equal(items[0].totalRupees, 20, "not \u20b92 \u2014 the leading count is not an amount");
  assert.equal(items[0].serviceName, "A4 Photocopy", "the 4 in A4 is a paper size, not an amount");
  assert.equal(items[1].quantity, 2, "a trailing x2 count");
  assert.equal(items[1].totalRupees, 110);
});

test("the rate is derived from the line total, because the total is what was paid", () => {
  /* 2 \u00d7 \u20b94.00 = \u20b99.00 was charged, so the unit rate is \u20b94.50. createTransaction()
     recomputes total = qty \u00d7 rate, and a rate that disagreed with the total
     would book a line the customer never paid for. */
  const [item] = parseReceiptLines("2 x A4 Photocopy   4.00   9.00");
  assert.equal(item.quantity, 2);
  assert.equal(item.totalRupees, 9);
  assert.equal(item.rateRupees, 4.5);
  assert.equal(scanItemPaise(item), 900);
});

test("a line with a name but no figure is kept unpriced, for the shopkeeper to fill", () => {
  const items = parseReceiptLines(["Spiral Binding", "A4 Photocopy  4.00  20.00"].join("\n"));
  assert.equal(items.length, 2, "an unreadable amount is not a reason to hide the line");
  assert.equal(scanItemPaise(items[0]), null);
  assert.equal(items[0].rateRupees, null);
  assert.equal(scanItemPaise(items[1]), 2000);
});

test("the bill's own footers are not sold", () => {
  const items = parseReceiptLines(
    [
      "Sub Total 120.00",
      "Total 120.00",
      "Amount Paid 120.00",
      "GST 18% 18.12",
      "Round Off 0.00",
      "Cash 1000.00",
      "Change 880.00",
      "Bill No: 4471",
      "12:05 pm",
      "12/05/2026",
      "A4 Photocopy 4.00 16.00",
    ].join("\n"),
  );
  assert.deepEqual(items.map((i) => i.serviceName), ["A4 Photocopy"]);
});

test("OCR repeating a line is one line, and a statement is capped", () => {
  const noisy = ["A4 Photocopy 4.00 20.00", "A4 Photocopy 4.00 20.00", "  A4  Photocopy   4.00 20.00 "];
  assert.equal(parseReceiptLines(noisy.join("\n")).length, 1);

  /* Distinct letter-only names, so the cap is what ends the list and
     not the de-duplication of a name the reader emptied out. */
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const long = Array.from({ length: MAX_SCANNED_ITEMS + 6 }, (_, i) =>
    `Job ${alphabet[i % 26]}${alphabet[Math.floor(i / 26)]} 10.00 10.00`,
  );
  assert.equal(parseReceiptLines(long.join("\n")).length, MAX_SCANNED_ITEMS);
});

/* ---------------- Normalising whatever arrived ---------------- */

test("the model's array is normalised into the same shape as the OCR lines", () => {
  const items = normalizeScanItems([
    { serviceName: "A4 Photocopy", quantity: 5, rateRupees: 4 },
    { serviceName: "Passport Photo", totalRupees: 100 },
    { name: "  Spiral   Binding  " },
    { serviceName: "", totalRupees: 50 },
    null,
  ]);

  assert.equal(items.length, 3, "the nameless entry is dropped, not shown as a blank line");
  assert.equal(items[0].quantity, 5);
  assert.equal(items[0].totalRupees, 20, "a rate is turned back into the line total");
  assert.equal(items[1].rateRupees, 100, "a line total is turned back into the rate");
  assert.equal(items[2].serviceName, "Spiral Binding");
  assert.equal(items[2].quantity, 1);
});

test("an item's quantity is a whole number, at least one, at most the ledger's own ceiling", () => {
  const [item] = normalizeScanItems([
    { serviceName: "A4 Photocopy", quantity: "2.7", rateRupees: 4 },
  ]);
  assert.equal(item.quantity, 2);

  const [capped] = normalizeScanItems([
    { serviceName: "A4 Photocopy", quantity: MAX_QUANTITY + 50, rateRupees: 4 },
  ]);
  assert.equal(capped.quantity, MAX_QUANTITY);

  const [floored] = normalizeScanItems([
    { serviceName: "A4 Photocopy", quantity: 0, rateRupees: 4 },
  ]);
  assert.equal(floored.quantity, 1);
});

test("the same line twice in one bill is one sale", () => {
  const items = normalizeScanItems([
    { serviceName: "A4 Photocopy", quantity: 5, rateRupees: 4 },
    { serviceName: "a4 photocopy", quantity: 5, rateRupees: 4 },
    { serviceName: "A4 Photocopy", quantity: 2, rateRupees: 4 },
  ]);
  assert.equal(items.length, 2, "the same service at a different quantity is a different line");
});

test("the batch total counts what is priced and what is not", () => {
  const total = scanItemsTotal([
    { serviceName: "A4 Photocopy", quantity: 5, rateRupees: 4 },
    { serviceName: "Spiral Binding", quantity: 1, rateRupees: null },
    { serviceName: "Passport Photo", quantity: 1, rateRupees: 100 },
  ]);
  assert.equal(total.totalPaise, 12000, "the unpriced line adds nothing, and says so");
  assert.equal(total.priced, 2);
  assert.equal(total.unpriced, 1);
  assert.equal(total.count, 3);
});

/* ---------------- An unknown name is a question ---------------- */

test("a name the shop has catalogued still matches on its own", () => {
  assert.equal(rankCatalogMatches("A4 Photocopy", CATALOG).match.serviceId, "s1");
  assert.equal(rankCatalogMatches("  passport   photo ", CATALOG).match.serviceId, "s2");
  assert.equal(rankCatalogMatches("Lamination", CATALOG).match.serviceId, "s4");
});

test("an unknown name is NOT silently replaced by the nearest service", () => {
  /* "Laminate A4" is a real thing a shop sells. Booking it as
     "Lamination" would put the wrong line in the ledger and the
     shopkeeper would never see it happen. */
  const { match, candidates } = rankCatalogMatches("Laminate A4", CATALOG);
  assert.equal(match, null, "nothing in this catalog is Laminate A4, so nothing is claimed to be");
  assert.ok(
    candidates.length > 0,
    "but the closest services are offered, so the question can be answered in one tap",
  );
  assert.ok(
    candidates.some((c) => c.serviceId === "s4"),
    "Lamination is among the suggestions",
  );
  assert.ok(candidates.length <= 3, "a thumb's width of choices, not the whole catalog");
});

test("an unknown name with nothing near it offers the closest anyway", () => {
  const { match, candidates } = rankCatalogMatches("Xylophone Tuning", CATALOG);
  assert.equal(match, null);
  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.every((c) => c.active !== false));
});

test("an archived service is never offered, matched or suggested", () => {
  assert.equal(rankCatalogMatches("Old Service", CATALOG).match, null);
  const { candidates } = rankCatalogMatches("Old Service", CATALOG);
  assert.ok(!candidates.some((c) => c.serviceId === "s6"));
});

test("two services that score the same break towards the shorter name", () => {
  /* Both catalog names merely CONTAIN what the bill said, so they score
     alike — and a bill that just says "photocopy" is the shorter
     service's line, not the one with three more words in the name. */
  const tied = [
    { serviceId: "short", name: "A4 Photocopy", pricePaise: 400 },
    { serviceId: "long", name: "Colour Photocopy A4", pricePaise: 800 },
  ];
  assert.equal(rankCatalogMatches("photocopy", tied).match.serviceId, "short");
});

test("a name with nothing to compare against yields nothing, not a throw", () => {
  assert.deepEqual(rankCatalogMatches("", CATALOG), { match: null, candidates: [] });
  assert.deepEqual(rankCatalogMatches(null, []), { match: null, candidates: [] });
  assert.deepEqual(rankCatalogMatches("Anything", null), { match: null, candidates: [] });
});

/* ---------------- The instruction that started this ---------------- */

test("the extraction prompt asks for the bill's lines, not one summary line", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "image-receipt.js"), "utf8");

  assert.ok(
    !/largest\s*\/\s*primary\s+line\s+item/i.test(src),
    "the old instruction summarised a multi-line receipt down to its largest line, " +
      "which is what left two lines of a three-line bill out of the ledger",
  );
  assert.match(src, /A bill is a LIST/, "the prompt has to say so in words the model follows");
  assert.match(src, /"items":\s*\[/, "the schema asks for a list of lines");
  assert.match(
    src,
    /openReview\(/,
    "a multi-line bill must go to the review, which is where the list is shown",
  );
});
