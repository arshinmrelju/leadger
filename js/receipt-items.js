/* =========================================================
   TrustX Ledger — Reading a scanned bill into line items
   -----------------------------------------------------------------
   THE GAP THIS MODULE FILLS
   A bill is a LIST. A photocopy counter's ₹230 receipt is three
   lines — 20 A4 photocopies, one passport photo, one spiral
   binding — and the scanner used to be told to summarise a
   multi-line receipt down to its largest line. So a three-line
   bill booked one sale, and the other two lines of real money
   were never in the ledger at all. The shopkeeper's only remedy
   was to notice, and to retype the rest by hand.

   So the reading step now keeps every line, and the shopkeeper
   is shown all of them and books them together.

   WHY IT IS ITS OWN MODULE
   Two callers want this logic and neither of them is a dialog:
   the Gemini extractor (js/image-receipt.js) hands over an array
   the model produced, and the offline OCR path hands over raw
   text off a photo. Both need the same three things — normalise
   whatever arrived into honest line items, price them the way the
   ledger will, and rank the shop's catalog against a name that
   was read rather than typed. That is all pure arithmetic and
   regular expressions, so it lives here where tests/ledger.mjs's
   siblings can exercise it in Node with no browser, no Firebase
   and no DOM.

   WHAT "HONEST" MEANS FOR A LINE
   The bill's line TOTAL is the number that was actually paid, so
   it outranks the printed rate: when a line says 2 × ₹4.00 =
   ₹9.00 the rate entered here is ₹4.50, because a rate is not a
   separate truth, it is the total divided by the quantity, and
   that is exactly how createTransaction() will recompute it. A
   line that arrived with no numbers at all is kept (the review
   needs to show it) but has no price, and the review refuses to
   book the batch until the shopkeeper fills one in.
   ========================================================= */

import {
  MAX_QUANTITY,
  MAX_RATE_PAISE,
  MAX_TOTAL_PAISE,
  toPaise,
  computeTotalPaise,
  sanitizeQuantity,
} from "./utils.js";

/**
 * A bill longer than this is a statement, not a counter receipt,
 * and the review list is a phone screen. Extra lines are dropped
 * at the cap rather than pushing every row below the fold.
 */
export const MAX_SCANNED_ITEMS = 12;

/** The catalog name column's own limit (js/ledger.js). */
const MAX_NAME = 80;

/**
 * The score at which a catalog service stops being a suggestion
 * and becomes the answer.
 *
 * It is the threshold this app has always used for a scan match
 * (`matchAiServiceToCatalog`), kept at the same number so a bill
 * that used to book automatically still books automatically. The
 * scoring below it is wider, so the near misses are now worth
 * showing too — which is the point: a wrong silent match is worse
 * than a named question.
 */
const MATCH_FLOOR = 24;

/** How many near misses to offer. Three is a thumb's width of choices. */
const CANDIDATE_LIMIT = 3;

/* =========================================================
   Small numeric helpers
   ========================================================= */

/** Round to paise, so money never accumulates a third decimal. */
function round2(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

/**
 * A rupee amount off a bill, or null when it is not one.
 *
 * Bounded by the same ceilings the write path enforces
 * (js/utils.js): a per-unit rate cannot exceed MAX_RATE_PAISE and
 * a line cannot exceed MAX_TOTAL_PAISE, so a misread digit is
 * dropped here rather than arriving at the rules as a denial.
 */
export function clampScanRupees(value, maxPaise = MAX_RATE_PAISE) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const paise = Math.round(n * 100);
  if (paise < 0 || paise > maxPaise) return null;
  return paise / 100;
}

/** Whole units, at least 1, at most the ledger's own quantity ceiling. */
function clampQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_QUANTITY, Math.floor(n));
}

/* =========================================================
   Reading line items out of raw OCR text
   ========================================================= */

/**
 * Lines that are about the BILL, not about anything the shop sold.
 *
 * The word list is deliberately blunt and ordered by how much
 * damage a false positive does: a "Sub Total" read as a service
 * books a sale the customer never bought, which is far worse than
 * dropping a real line — the shopkeeper adds a missing line in
 * two taps, and cannot un-book one that is already in the ledger.
 */
const FOOTER_LINE =
  /(^|\b)(sub\s*-?\s*total|subtotal|grand\s*total|total|net\s*amount|net\s*payable|amount|amt|bill\s*total|amount\s*due|amount\s*paid|balance\s*due|balance|round\s*off|cash\s*round|discount|rebate|coupon|gst|cgst|sgst|igst|tax|vat|hsn|cess|change|paid|received|cash|upi|neft|rtgs|imps|cheque|thank\s*you|thanks|welcome|reprint|regd|regd\.?\s*no|gstin|vat\s*no|pan\s*:|bill\s*(no|number|#)|invoice\s*(no|number|#)|receipt\s*(no|number|#)|sl\s*(no|number)|order\s*(no|id)|date|time|cashier|counter|served\s*by|customer|mobile|phone|tel|email|www\.|http|\.com|\.in\b|note|signature|auth|authorised|printed|software|powered)/i;

/** A line that is only a date, or only a clock time, with or without am/pm. */
const DATE_LINE = /^\s*\d{1,2}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{2,4}\s*$/;
const TIME_LINE = /^\s*\d{1,2}\s*[:.]\s*\d{2}\s*([ap]m)?\s*$/i;
/**
 * "01/10/2026  11:42 AM" — a date, optionally with the time beside it.
 *
 * Its own pattern rather than a stripped-down DATE_LINE, because the
 * meridiem is what breaks the simple test: strip the digits as amounts
 * and "11:42 AM" leaves a standing "AM" to be read as a ₹42 service.
 */
const STAMP_LINE =
  /^\s*\d{1,2}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{2,4}(\s+\d{1,2}\s*[:.]\s*\d{2})?\s*([ap]m)?\s*$/i;

/** Every number on the line, with the span it occupied. */
function numbersIn(line) {
  const found = [];
  for (const m of line.matchAll(/(\d[\d,]*(?:\.\d{1,2})?)/g)) {
    /* A digit glued to a letter is part of a word, not an amount: "A4
       Photocopy", "B5", "CD". Reading the 4 out of "A4" turned the
       service's name into "A Photocopy" AND booked a phantom \u20b94 —
       which is how a whole line ends up mispriced and misnamed at once. */
    const before = m.index > 0 ? line[m.index - 1] : "";
    if (before && /[A-Za-z\u0900-\u097F\d]/.test(before)) continue;
    found.push({
      value: Number(m[1].replace(/,/g, "")),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return found;
}

/** The line with every number lifted out — which is where the name is. */
function nameFromLine(line, numbers) {
  let rest = "";
  let cursor = 0;
  for (const n of numbers) {
    rest += line.slice(cursor, n.start);
    cursor = n.end;
  }
  rest += line.slice(cursor);
  /* What is left is the description surrounded by the separators
     that framed its numbers: ₹ signs, "x", "@", "=", colons and
     commas. They are noise once the numbers are gone. */
  return rest
    .replace(/[₹\s.,:;|/\\]/g, " ")
    .replace(/\b(?:rs\.?|inr|rupees?)\b/gi, " ")
    .replace(/[=~*–—\-]/g, " ")
    /* A leading count that survived because it was spelled out:
       "2 x Photocopy" is the name "Photocopy". */
    .replace(/^\s*\d{1,4}\s*[x×]\s*/i, " ")
    .replace(/^[x×]\s*/i, " ")
    .replace(/\s*[x×]\s*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A usable name: letters, short enough to be a service, not a sentence. */
function isPlausibleName(name) {
  if (!name || name.length < 2 || name.length > 60) return false;
  const letters = (name.match(/[A-Za-z\u0900-\u097F]/g) || []).length;
  return letters >= 2;
}

/**
 * Printed in capitals and carrying no amount: the shop's own name, a
 * department heading, a "THANK YOU" banner.
 *
 * This is the only way a header can be told from a real line whose
 * figure wrapped onto the next one, and the two are worth different
 * amounts of doubt. A service name on a bill is printed in the bill's
 * own case; a header is shouted. Keeping every nameless-of-money line
 * would have shown "TRUSTX DIGITAL SOLUTIONS" as a \u20b90 sale on the
 * review list, which is the kind of thing that teaches a shopkeeper to
 * stop trusting the scanner.
 */
function looksLikeHeader(name) {
  const letters = name.replace(/[^\p{L}]/gu, "");
  return letters.length > 2 && letters === letters.toUpperCase();
}

/**
 * How many units a line is for, from the ways bills write it:
 * a leading "2 x", a trailing "x2", or a spelled-out "Qty: 2".
 * Returns 1 when the line does not say.
 */
function quantityFromLine(line) {
  const patterns = [
    /^\s*(\d{1,4})\s*[x×]/,
    /\b(?:qty|quantity|qnt|nos?\.?)\s*:?\s*(\d{1,4})\b/i,
    /\b(\d{1,4})\s*[x×]\s*$/,
    /[x×]\s*(\d{1,4})\b/,
  ];
  for (const re of patterns) {
    const m = line.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= MAX_QUANTITY) return n;
  }
  return 1;
}

/**
 * One bill line → one item, or null when the line is not an item.
 *
 * The amounts are read positionally, the way a receipt prints them:
 * the last two numbers on a sold line are the rate and the line
 * total ("A4 Photocopy  4.00  20.00"), and a line with one number
 * is a line total on its own. A number consumed as the quantity is
 * not also read as a money amount, which is what keeps a leading
 * "2 x" from being booked as ₹2 of photocopies.
 */
function readItemLine(line) {
  const text = String(line || "").trim();
  if (!text || text.length > 120) return null;
  /* The meridiem and the date are one stamp, not a service: a bill
     prints "01/10/2026  11:42 AM" on one line, and read as amounts it
     becomes a \u20b942 sale called "AM". */
  if (STAMP_LINE.test(text) || DATE_LINE.test(text) || TIME_LINE.test(text)) return null;
  /* A footer check on the WHOLE line, not the name: "Total 250.00"
     has no name to reject it later, and "Photocopy (total)" is not
     a thing. */
  if (FOOTER_LINE.test(text)) return null;

  const quantity = quantityFromLine(text);
  let numbers = numbersIn(text);
  /* Drop the number that turned out to be the quantity. Only a
     leading "N x" is safe to remove by position; a "Qty: 2" is
     already inside a footer-ish label and its number is the one
     just before the amounts, so it is removed by value and only
     when a money amount is still left over. */
  if (quantity > 1 && numbers.length) {
    const lead = /^\s*(\d{1,4})\s*[x×]/.exec(text);
    if (lead) {
      numbers = numbers.filter((n) => n.start !== lead.index);
    } else if (numbers.length > 1) {
      const withoutQty = numbers.filter((n) => n.value !== quantity);
      if (withoutQty.length) numbers = withoutQty;
    }
  }

  const name = nameFromLine(text, numbers);
  if (!isPlausibleName(name)) return null;

  /* No amount at all: keep the line, unpriced. A bill that lists
     "Spiral binding" with the figure on the next line still gets
     shown, and the shopkeeper prices it. */
  const amounts = numbers
    .map((n) => n.value)
    .filter((v) => Number.isFinite(v) && v > 0)
    .map((v) => clampScanRupees(v, MAX_TOTAL_PAISE))
    .filter((v) => v !== null);

  let totalRupees = null;
  let rateRupees = null;
  if (amounts.length === 1) {
    totalRupees = amounts[0];
  } else if (amounts.length > 1) {
    rateRupees = amounts[amounts.length - 2];
    totalRupees = amounts[amounts.length - 1];
  }

  /* No amount at all: keep the line, unpriced, so a figure that wrapped
     onto the next line does not cost the shop a sale — unless it is a
     header, which is not a sale however it is printed. */
  if (totalRupees === null && looksLikeHeader(name)) return null;

  /* The total is what was paid, so the rate is derived from it
     rather than trusted: 2 × 4.00 = 9.00 must book as ₹4.50 a unit,
     not as a line that adds up to ₹8. */
  if (totalRupees !== null) rateRupees = round2(totalRupees / quantity);

  return { serviceName: name, quantity, rateRupees, totalRupees };
}

/**
 * Every sold line in a block of OCR text, in the order printed.
 *
 * Conservative by design: a line that cannot be read as
 * "description, quantity, money" is dropped, because a wrong line
 * is money the ledger will never give back. Returns [] when nothing
 * looked like a sale, and the caller falls back to the single-item
 * reading it used before.
 */
export function parseReceiptLines(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const items = [];
  const seen = new Set();
  for (const line of lines) {
    const item = readItemLine(line);
    if (!item) continue;
    /* Tesseract repeats itself on a noisy photo. The same line
       twice is one line, not two sales. */
    const key = `${item.serviceName.toLowerCase()}|${item.quantity}|${item.rateRupees}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= MAX_SCANNED_ITEMS) break;
  }
  return items;
}

/* =========================================================
   Normalising whatever arrived (Gemini's array, or the OCR lines)
   ========================================================= */

/**
 * Force a scanned item into the shape the ledger can be asked to
 * write: a name, a whole quantity, a rate, and — when the two are
 * known — a total that agrees with them.
 */
function normalizeItem(raw) {
  const name = cleanScanName(
    raw && raw.serviceName !== undefined ? raw.serviceName : raw && raw.name
  );
  if (!name) return null;

  const quantity = clampQuantity(raw.quantity);
  let totalRupees = clampScanRupees(raw.totalRupees, MAX_TOTAL_PAISE);
  const printedRate = clampScanRupees(raw.rateRupees, MAX_RATE_PAISE);

  let rateRupees = printedRate;
  if (totalRupees !== null) rateRupees = round2(totalRupees / quantity);
  else if (printedRate !== null) totalRupees = round2(printedRate * quantity);

  return { serviceName: name, quantity, rateRupees, totalRupees };
}

/**
 * Tidy a name that came off a bill: a leading count, collapsed
 * space, the catalog's own length limit.
 */
export function cleanScanName(value, max = MAX_NAME) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .replace(/^\s*\d{1,4}\s*[x×]\s*/i, "")
    .replace(/^[x×]\s*/i, "")
    /* "x3" is a count too: a bill that printed the count after the
       name would otherwise have it read as part of the name, and
       "Passport Photo x3" matches nothing in the catalog. */
    .replace(/\s*[x×]\s*\d{1,4}\s*$/i, "")
    .replace(/^[\s\-:.,]+|[\s\-:.,]+$/g, "")
    .trim()
    .slice(0, max);
}

/**
 * The whole extraction result → a list of line items.
 *
 * Always returns a list, never a single item: the single-item
 * bill is just the one-line case of the same thing, so there is
 * one shape for the caller to render instead of two.
 */
export function normalizeScanItems(rawItems, { maxItems = MAX_SCANNED_ITEMS } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    if (out.length >= maxItems) break;
    const item = normalizeItem(raw || {});
    if (!item) continue;
    const key = `${item.serviceName.toLowerCase()}|${item.quantity}|${item.rateRupees}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** One item's worth in paise, or null when it is not priced yet. */
export function scanItemPaise(item) {
  if (!item) return null;
  const qty = sanitizeQuantity(item.quantity);
  const ratePaise = toPaise(item.rateRupees);
  if (qty === null || ratePaise === null) return null;
  return computeTotalPaise(qty, ratePaise);
}

/**
 * A bill's worth in paise, and how much of it is actually priced.
 *
 * The counts are what the review's save button is gated on: a
 * batch with an unpriced line must not book, because the line
 * total on screen would then be a lie.
 */
export function scanItemsTotal(items) {
  let totalPaise = 0;
  let priced = 0;
  let unpriced = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const paise = scanItemPaise(item);
    if (paise === null) {
      unpriced += 1;
      continue;
    }
    totalPaise += paise;
    priced += 1;
  }
  return { totalPaise, priced, unpriced, count: Array.isArray(items) ? items.length : 0 };
}

/* =========================================================
   Matching a name that was READ against the shop's catalog
   ========================================================= */

/** Lowercase, letters and digits only — the form both sides compare in. */
function matchText(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sørensen–Dice over character trigrams: 0 (nothing alike) … 1 (same). */
function diceCoefficient(a, b) {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const trigrams = (s) => {
    const out = new Map();
    for (let i = 0; i <= s.length - 3; i += 1) {
      const g = s.slice(i, i + 3);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  let total = 0;
  for (const n of ta.values()) total += n;
  for (const n of tb.values()) total += n;
  for (const [g, n] of ta) shared += Math.min(n, tb.get(g) || 0);
  return total ? (2 * shared) / total : 0;
}

/**
 * How alike two names are, on top of the exact/substring rules the
 * app has always used.
 *
 * The token pass is what catches a bill's own wording for a
 * catalogued service — "Laminate A4" against "Lamination", "Black
 * & White" against "Photocopy / Print" — through shared words and
 * through words that are prefixes of one another. The trigram pass
 * is the last resort for a genuine typo ("Passprt photo").
 */
function scoreName(query, queryTokens, name) {
  if (name === query) return 1000;
  if (name.startsWith(query) || query.startsWith(name)) return 400;
  if (name.includes(query) || query.includes(name)) return 200;

  const nameTokens = name.split(" ").filter(Boolean);
  let score = 0;
  for (const qt of queryTokens) {
    if (qt.length < 2) continue;
    for (const nt of nameTokens) {
      if (nt === qt) {
        score += qt.length * 6;
        break;
      }
      if (qt.length >= 4 && nt.length >= 4 && (nt.startsWith(qt) || qt.startsWith(nt))) {
        score += Math.min(qt.length, nt.length) * 4;
        break;
      }
      if (qt.length >= 5 && nt.length >= 5) {
        const alike = diceCoefficient(qt, nt);
        if (alike >= 0.6) {
          score += Math.round(alike * 24);
          break;
        }
      }
    }
  }
  return score;
}

/**
 * Rank the shop's catalog against a name read off a bill.
 *
 * @returns {{match: object|null, candidates: object[]}} `match` is the
 *   service the app is confident enough to book on its own (score ≥
 *   MATCH_FLOOR, as it always has been), and `candidates` are the
 *   near misses for the shopkeeper to choose from. An unknown name
 *   used to be a dead end — the form simply refused the sale — so the
 *   second half of this answer is the point of the exercise: the
 *   question gets asked instead of the entry being turned away.
 */
export function rankCatalogMatches(name, services) {
  const query = matchText(name);
  const empty = { match: null, candidates: [] };
  if (!query) return empty;

  const queryTokens = query.split(" ").filter(Boolean);
  const scored = [];
  for (const service of Array.isArray(services) ? services : []) {
    if (!service || service.active === false) continue;
    const catalogName = matchText(service.name);
    if (!catalogName) continue;
    scored.push({ service, score: scoreName(query, queryTokens, catalogName) });
  }
  if (!scored.length) return empty;

  /* Ties break towards the shorter catalog name: "Photocopy" is a
     better answer than "Photocopy / Print / Colour" for a bill that
     simply says "photocopy". */
  scored.sort((a, b) => b.score - a.score || String(a.service.name).length - String(b.service.name).length);

  const best = scored[0].score >= MATCH_FLOOR ? scored[0].service : null;
  /* The chosen service is not also offered as a suggestion: a chip that
     repeats what is already selected is noise on a phone. */
  const candidates = scored
    .filter((r) => r.score > 0 && (!best || r.service.serviceId !== best.serviceId))
    .slice(0, CANDIDATE_LIMIT)
    .map((r) => r.service);

  return { match: best, candidates };
}
