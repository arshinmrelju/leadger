/* =========================================================
   TrustX Ledger — Scan Receipt: upload + AI extract → sale form
   -----------------------------------------------------------------
   TWO FREE EXTRACTION PATHS (no OpenAI, no credit card):

     1. GOOGLE GEMINI 1.5 FLASH (primary, if API key is set)
        — structured JSON via schema, great accuracy even on handwriting
        — free tier: 1,500 requests/day from aistudio.google.com

     2. TESSERACT.JS OCR + INDIAN-RECEIPT HEURISTICS (fallback, always)
        — runs 100% in the browser after CDN load (~10 MB eng model)
        — no data leaves the device, works offline after first use
        — regexes tuned for ₹ amounts, qty, UPI/cash mentions, dates

    Flow:
     1. openScanReceiptModal() — drag-and-drop / pick-file
     2. HEIC → JPEG via heic2any (CDN on demand) if needed
     3. Client-side downscale to ~1400px long edge, jpeg compress
     4. Preview shown → user clicks "Analyze receipt"
     5. If Gemini key present → POST base64 image to Gemini with schema
        Else → Tesseract OCR → heuristic parser → structured JSON
     6. ONE line on the bill → match the catalog, pre-fill the sale form
        → the shopkeeper reviews and saves.
        SEVERAL lines on the bill → they are NOT collapsed into the
        biggest one. The scan modal grows a review list, one row per
        line read off the bill, and the shop books the bill as a
        batch. (js/receipt-items.js does the reading and the ranking.)

   WHERE THE PHOTO ENDS UP
   A second, smaller encode of the same bitmap is handed to the sale form and
   saved as its own Firestore document, `dayHeads/{dateKey}/receiptImages/
   {txnId}`, in the same batch as the sale. Not Cloud Storage: the project
   has none set up, and a receipt belongs beside the day and the rules that
   already govern the money. Not on the sale document either — base64 is 4/3
   the picture and would ride along with every listing of the day; this way
   it is read only when someone opens it.
   ========================================================= */

import { toast, setLoading, openModal, closeModal, confirm } from "./app.js";
import {
  todayKolkata,
  isValidDateKey,
  escapeHtml,
  isPaymentMethod,
  formatINR,
  paiseToInput,
  rateToPaise,
  sanitizeQuantity,
  computeTotalPaise,
  toPaise,
  RECEIPT_IMAGE_MAX_BYTES,
  isStorableReceiptImage,
} from "./utils.js";
import { fetchServices, createService, createTransaction, fetchDayState, isNetworkError } from "./ledger.js";
import { openSaleForm, prefillSaleForm, celebrateSavedSale, emitSaleRecorded } from "./sale-form.js";
import { createServicePicker, serviceTile } from "./service-picker.js";
import { reportError } from "./auth.js";
import { isQuotaExhausted, quotaResetTime } from "./quota.js";
import {
  parseReceiptLines,
  normalizeScanItems,
  rankCatalogMatches,
  scanItemPaise,
  scanItemsTotal,
  clampScanRupees,
  MAX_SCANNED_ITEMS,
} from "./receipt-items.js";
import {
  AI_CONFIG,
  isGeminiConfigured,
  aiSetupNotice,
  noKeyModeLabel,
} from "./ai-config.js";

/* ---------- Icons ---------- */

const ICON_CAMERA =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

const ICON_CLOSE =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

const ICON_SPARKLES =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 4.6L18 9l-4.1 1.4L12 15l-1.9-4.6L6 9l4.1-1.4z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/></svg>';

const ICON_UPLOAD =
  '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';

/* ---------- Module state ---------- */

let scanOverlay = null;
let currentRawFile = null;
let currentDataUrl = null;
/** The smaller copy of the same photo the ledger stores beside the sale. */
let currentLedgerImage = null;
let currentServices = [];
let analyzing = false;
/**
 * A bill that came back with more than one line on it, waiting to be
 * checked and booked as a batch. Null whenever the scan modal is not
 * showing that review, so the save button can never fire against a
 * list the shopkeeper is not looking at.
 */
let currentScan = null;
let savingScan = false;

/* ---------- HEIC / image helpers ---------- */

let heic2anyPromise = null;

function loadHeic2any() {
  if (heic2anyPromise) return heic2anyPromise;
  heic2anyPromise = (async () => {
    const src = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
    await new Promise((resolve, reject) => {
      if (typeof window.heic2any === "function") return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("HEIC converter failed to load from CDN."));
      document.head.appendChild(s);
    });
    if (typeof window.heic2any !== "function") {
      throw new Error("HEIC converter loaded but heic2any() is missing.");
    }
    return window.heic2any;
  })();
  return heic2anyPromise;
}

function fileIsHeic(file) {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  return (
    name.endsWith(".heic") ||
    name.endsWith(".heif") ||
    type.includes("heic") ||
    type.includes("heif")
  );
}

/**
 * Convert any supported File → JPEG blob, with HEIC conversion + downscale.
 * Returns { dataUrl, jpegBlob, width, height }.
 */
async function prepareImageForAi(file) {
  if (!file) throw new Error("No image file received.");

  let blob;
  if (fileIsHeic(file)) {
    toast("Converting iPhone photo…", "info", 1500);
    const conv = await loadHeic2any();
    try {
      const result = await conv({
        blob: file,
        toType: "image/jpeg",
        quality: AI_CONFIG.jpegQuality,
      });
      blob = result instanceof Blob ? result : result[0];
    } catch (err) {
      throw new Error("Could not convert this iPhone (HEIC) photo. Try saving it as JPEG first.");
    }
  } else {
    blob = file;
  }

  const img = await loadImageFromBlob(blob);
  const prepared = await downscaleToJpeg(img);
  /* The decoded bitmap is kept as well: the ledger's own, smaller copy is
     rendered from this same image rather than decoding the file again. */
  return { ...prepared, img };
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This file does not look like an image."));
    };
    img.src = url;
  });
}

/**
 * Re-encode a decoded image as a JPEG at a given size and quality.
 *
 * One function for both jobs the app has, because they differ only in the
 * numbers: the AI wants the biggest readable picture it can get, while the
 * copy kept in the ledger has to fit inside a Firestore document. Encoding
 * twice from the same decoded bitmap is cheaper and simpler than decoding
 * the file twice.
 */
function renderJpeg(img, { maxEdge, quality, maxBytes }) {
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (!w || !h) throw new Error("Could not read image dimensions.");

  const scale = Math.min(1, maxEdge / Math.max(w, h));
  w = Math.round(w * scale);
  h = Math.round(h * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error("Image encoding failed."));
        /* Over the ceiling: resolve null instead of rejecting, so the caller
           decides what an unsaveable picture means. */
        if (maxBytes && blob.size > maxBytes) return resolve(null);
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read image data."));
        reader.onload = () =>
          resolve({ jpegBlob: blob, dataUrl: reader.result, width: w, height: h });
        reader.readAsDataURL(blob);
      },
      "image/jpeg",
      quality
    );
  });
}

/** The picture the AI reads: as much detail as the free tiers will take. */
function downscaleToJpeg(img) {
  return renderJpeg(img, {
    maxEdge: AI_CONFIG.downscaleLongEdge,
    quality: AI_CONFIG.jpegQuality,
    maxBytes: null,
  }).then((out) => {
    const sizeMb = out.jpegBlob.size / (1024 * 1024);
    if (sizeMb > AI_CONFIG.maxImageSizeMb * 1.2) {
      throw new Error(
        "Image is too large after resize (" + sizeMb.toFixed(1) + " MB). Try a smaller photo."
      );
    }
    return out;
  });
}

/**
 * The copy of the receipt the LEDGER keeps, in its own Firestore document.
 *
 * Deliberately smaller than the AI copy: this one is stored, listed against
 * every future read of the day, and has to live inside a 1 MiB document as
 * base64. A bill only has to stay readable on a phone screen to do its job,
 * so it is re-encoded at a shorter edge and a lower quality - which lands
 * most receipts well inside the ceiling instead of straddling it.
 *
 * Returns null rather than throwing when it will not fit: the sale is still
 * worth saving, and refusing the whole entry because a photo was large would
 * be the wrong trade.
 */
function encodeReceiptForLedger(img) {
  return renderJpeg(img, {
    maxEdge: AI_CONFIG.storeLongEdge,
    quality: AI_CONFIG.storeJpegQuality,
    maxBytes: RECEIPT_IMAGE_MAX_BYTES,
  });
}

/* =========================================================
   EXTRACT #1: Google Gemini 1.5 Flash + response schema
   ========================================================= */

const GEMINI_SYSTEM_PROMPT =
  `You are receipt-reading AI for a small Indian digital-service shop
(TrustX Ledger, currency Indian Rupee ₹). Return STRICT JSON only.

Shape (every field required; use null if genuinely unreadable):
{
  "items": [                      ONE ENTRY PER LINE THE SHOP SOLD
    { "serviceName": string,       short human-readable service. 2-60 chars.
      "quantity": number,          integer ≥ 1
      "rateRupees": number|null,   per-unit price; if unknown derive as total/quantity
      "totalRupees": number|null } that line's own amount
  ],
  "serviceName": string,       the largest / primary line from "items", repeated at the top level
  "totalRupees": number|null,  the BILL's grand total in RUPEES (not paise). ₹250 → 250. ₹15.50 → 15.5
  "quantity": number,          integer ≥ 1. The primary line's quantity. Use 1 if unclear.
  "rateRupees": number|null,   per-unit price; if unknown derive as total/quantity.
  "customerName": string|null, payer name if written, else null.
  "dateYYYYMMDD": string|null, receipt date as "YYYY-MM-DD" (Asia/Kolkata). Use null if illegible.
  "paymentMethod": "cash"|"upi"|"card"|"due"|null,
  "notes": string|null         any extra lines worth keeping (short, < 400 chars)
}

Rules:
- A bill is a LIST. Put EVERY line the customer was charged for into
  "items" — three sold lines means three entries, each with its own
  quantity, rate and amount. Do NOT merge them and do NOT keep only
  the largest: the shop keeps the ledger, and a dropped line is money
  it never sees again.
- Never put these in "items": subtotal, total, grand total, tax/GST,
  discount, round-off, change, balance, tender lines, "thank you",
  shop name, address, bill/invoice number, date, time, cashier.
- "serviceName" and "quantity"/"rateRupees" at the top level must
  repeat the largest/primary entry of "items", so a single-line bill
  reads correctly either way.
- Money is always INDIAN RUPEE (₹). Never invent another currency.
- Numbers with commas (₹1,250.50) → parse as 1250.5.
- If a word really can't be read, use null, not a guess.
- Never include markdown fences or prose — ONLY valid JSON.`;

async function extractWithGemini(dataUrl, onProgress) {
  if (onProgress) onProgress("Using Gemini AI — reading receipt…");
  const apiKey = AI_CONFIG.geminiApiKey.trim();
  const model = AI_CONFIG.geminiModel || "gemini-1.5-flash";
  const endpoint =
    `${AI_CONFIG.geminiEndpoint}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const parts = dataUrl.split(",");
  const base64 = parts.length === 2 ? parts[1] : parts[0];
  const mimeMatch = dataUrl.match(/data:([^;]+);base64/);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";

  const body = {
    systemInstruction: {
      role: "system",
      parts: [{ text: GEMINI_SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: mime, data: base64 } },
          { text: "Extract structured receipt JSON." },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      /* Was 500, which is one line and a bit. A three-line bill needs
         three objects of JSON, and a truncated response is a parse
         error the shopkeeper sees as "could not read this receipt". */
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          /* The bill as a list. This is the whole point: the one
             array field is what stops the scan from booking a single
             line of a multi-line receipt. */
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                serviceName: { type: "string" },
                quantity: { type: "number" },
                rateRupees: { type: ["number", "null"] },
                totalRupees: { type: ["number", "null"] },
              },
              required: ["serviceName", "quantity"],
            },
          },
          serviceName: { type: "string" },
          totalRupees: { type: ["number", "null"] },
          quantity: { type: "number" },
          rateRupees: { type: ["number", "null"] },
          customerName: { type: ["string", "null"] },
          dateYYYYMMDD: { type: ["string", "null"] },
          paymentMethod: {
            type: ["string", "null"],
            enum: ["cash", "upi", "card", "due", null],
          },
          notes: { type: ["string", "null"] },
        },
        required: ["serviceName", "quantity", "items"],
      },
    },
  };

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error("Network error talking to Gemini. Check your connection.");
  }
  if (!resp.ok) {
    let txt = "";
    try { txt = await resp.text(); } catch (_) { /* noop */ }
    if (resp.status === 400 && /API key|API_KEY|invalid/i.test(txt))
      throw new Error("Gemini API key looks invalid. Check js/ai-config.js.");
    if (resp.status === 429)
      throw new Error("Gemini free-tier rate limit hit — wait a moment or use offline OCR mode.");
    throw new Error(`Gemini error (${resp.status}). ${txt ? txt.slice(0, 200) : ""}`);
  }

  let data;
  try { data = await resp.json(); } catch (_) { throw new Error("Gemini returned unreadable JSON."); }

  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ||
    "";
  if (!text) throw new Error("Gemini returned empty content. Try a clearer photo.");

  let parsed;
  try { parsed = JSON.parse(text); } catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
    if (!parsed) throw new Error("Could not parse AI response. Try a clearer photo.");
  }
  return normalizeAiOutput(parsed);
}

/* =========================================================
   EXTRACT #2: Tesseract.js client-side OCR + heuristics
   (no API key, runs fully in-browser, fully free)
   ========================================================= */

let tesseractPromise = null;
function loadTesseract(onProgress) {
  if (tesseractPromise) return tesseractPromise;
  tesseractPromise = (async () => {
    if (onProgress) onProgress("Loading offline OCR engine (~10 MB, first use only)…");
    const src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
    await new Promise((resolve, reject) => {
      if (window.Tesseract && typeof window.Tesseract.recognize === "function") return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Tesseract.js failed to load from CDN. Connect to internet and try again."));
      document.head.appendChild(s);
    });
    return window.Tesseract;
  })();
  return tesseractPromise;
}

async function runTesseract(dataUrl, onProgress) {
  const T = await loadTesseract(onProgress);
  if (onProgress) onProgress("Reading text from receipt (offline OCR)…");
  let result;
  try {
    result = await T.recognize(dataUrl, "eng", {
      logger: (m) => {
        if (onProgress && m.status && typeof m.progress === "number") {
          if (m.status === "recognizing text") {
            const pct = Math.round(m.progress * 100);
            onProgress(`Reading text from receipt … ${pct}%`);
          }
        }
      },
    });
  } catch (err) {
    throw new Error("Offline OCR failed: " + (err.message || String(err)));
  }
  const text = (result && result.data && result.data.text) ? String(result.data.text) : "";
  if (!text || text.trim().length < 12) {
    throw new Error("Offline OCR could not read any text. Try a brighter, sharper photo.");
  }
  return text;
}

/**
 * Indian-receipt text → structured JSON via regex heuristics.
 * Tuned for ₹ amounts, "Total / Grand Total / TOTAL" lines, qty,
 * payment method words (CASH / UPI / PhonePe / Paytm / GPay / Card),
 * common Indian date formats (DD/MM/YYYY, DD-MM-YYYY, DD MMM YYYY).
 */
function parseReceiptTextHeuristically(text) {
  const t = String(text || "");
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const blob = " " + lines.join(" \n ") + " ";

  // -------- Total rupees --------
  // Match Rs/₹/INR/रु followed by optional space, digits with optional commas, optional .decimals
  // Prefer lines that contain "total / grand / bill / amount / payable"
  let totalRupees = null;
  const amountRe = /(?:₹|rs\.?|inr|रु|rupees?)\s*([0-9][0-9,]*\.?\d{0,2})/gi;
  const candidates = [];
  let amtMatch;
  while ((amtMatch = amountRe.exec(blob)) !== null) {
    const raw = amtMatch[1].replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 1000000) {
      const surrounding = blob.slice(Math.max(0, amtMatch.index - 80), amtMatch.index + amtMatch[0].length + 40).toLowerCase();
      let weight = 1;
      if (/\b(total|grand|bill|payable|balance|net|amount|amnt)\b/.test(surrounding)) weight += 5;
      if (/\b(sub|before|without|gst|vat|tax|items?)\b/.test(surrounding)) weight -= 1;
      candidates.push({ value: n, weight, surrounding });
    }
  }
  // Fallback: any bare number with two decimals near the end of the receipt, labelled "total"
  if (!candidates.length) {
    const bare = /\b([1-9][0-9]{0,5}(?:,[0-9]{3})*(?:\.\d{1,2})?)\b/g;
    let bm;
    while ((bm = bare.exec(blob)) !== null) {
      const raw = bm[1].replace(/,/g, "");
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n <= 1000000 && /\.\d\d$/.test(bm[1])) {
        const surrounding = blob.slice(Math.max(0, bm.index - 100), bm.index + bm[0].length + 30).toLowerCase();
        let weight = 0.4;
        if (/\b(total|grand|bill|payable|net)\b/.test(surrounding)) weight += 5;
        if (/\b(date|bill no|inv no|phone|mob|mobile|time)\b/.test(surrounding)) weight -= 2;
        candidates.push({ value: n, weight, surrounding });
      }
    }
  }
  if (candidates.length) {
    candidates.sort((a, b) => b.weight - a.weight || b.value - a.value);
    totalRupees = candidates[0].value;
  }

  // -------- Quantity --------
  // Look for "Qty: N", "Quantity N", "x N", "× N", "<digits> x <rate>" style lines
  let quantity = 1;
  const qtyRe = /\b(?:qty|quantity|qnt|no\.?|nos?)\s*:?\s*(\d{1,4})\b/i;
  const qm = blob.match(qtyRe);
  if (qm) {
    const q = Number(qm[1]);
    if (Number.isFinite(q) && q >= 1 && q <= 10000) quantity = q;
  } else {
    // Also match "N x Rs" at start of lines, e.g. "2 x Photocopy"
    const qm2 = blob.match(/\b(\d{1,4})\s*[x×]\s*(?=[a-z]|rs|₹|\d)/i);
    if (qm2) {
      const q = Number(qm2[1]);
      if (Number.isFinite(q) && q >= 2 && q <= 10000) quantity = q;
    }
  }

  // -------- Rate --------
  let rateRupees = null;
  if (totalRupees !== null && quantity > 0) {
    rateRupees = Math.round((totalRupees / quantity) * 100) / 100;
  }

  // -------- Service name --------
  // Heuristic: first non-metadata line, or a line containing keywords
  const services = [
    { re: /(photocop|photo\s*copy|xerox|copy\b|x\s*erox|print(?:out|ed|ing)?)/i, name: "Photocopy / Print" },
    { re: /(scan|scanning|scanned|scan\b)/i, name: "Scanning" },
    { re: /(passport|p\.?\s*assport|visa|travel|ticket|rail|train|flight|bus\s*reserv)/i, name: "Passport / Travel form" },
    { re: /(pan\s*card|pancard|aadhaar|aadhar|voter|ration|id\s*card|identity|dl|driving)/i, name: "ID / Govt card form" },
    { re: /(recharge|top\s*up|topup|mobile|phone\s*bill|dth|electricity|electric|eb|water\s*bill|bill\s*pay|payment\s*of|gas\s*bill)/i, name: "Recharge / Bill payment" },
    { re: /(money\s*transfer|d\.?\s*m\.?\s*t\.?|upi\s*trf|neft|rtgs|imps|cash\s*deposit|withdraw)/i, name: "Money transfer / DMT" },
    { re: /(photo|photo\s*print|passport\s*size|stamp|photo\s*stamp)/i, name: "Passport photo" },
    { re: /(birth|death|marriag|caste|income|non\s*creamy|domicile|certificate|certif|apply\s*online|application\s*form|form\s*fill|filling)/i, name: "Certificate / Form fill-up" },
    { re: /(laptop|computer|system|format|os\s*install|windows|driver|repair|antivirus)/i, name: "Computer / DTP work" },
    { re: /(notary|attest|affidavit|stamp\s*paper|agreement)/i, name: "Notary / Affidavit" },
  ];
  let serviceName = null;
  for (const s of services) {
    if (s.re.test(blob)) { serviceName = s.name; break; }
  }
  if (!serviceName) {
    // No keyword hit: fall back to the longest alphabetic "body" line (skip dates, totals, metadata)
    const stopRe = /^(total|grand|amount|bill\s*no|invoice\s*no|inv\s*#|receipt\s*no|date|time|phone|mobile|mob\.?|email|qty|rate|thank|welcome|address|shop|store|gstin|tan|pan\s*:|thanks|regards)$/i;
    const scoredLines = lines
      .map((l) => ({ l, score: heuristicLineScore(l, stopRe) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scoredLines.length) serviceName = scoredLines[0].l.slice(0, 60);
  }
  if (!serviceName) serviceName = "Receipt item";

  // -------- Customer name --------
  // "Customer / Party / Name / Received from: X" style lines
  let customerName = null;
  const custRe = /\b(?:customer|party|name|received\s+from|mr\.?|mrs\.?|ms\.?|to|billing|shipped\s+to)\s*:?\s*([A-Z][A-Za-z\u0900-\u097F\s\.]{2,60})/;
  const cm = blob.match(custRe);
  if (cm) customerName = cm[1].replace(/\s+/g, " ").trim().slice(0, 120);

  // -------- Date --------
  let dateKey = null;
  // DD/MM/YYYY | DD-MM-YYYY | DD.MM.YYYY
  let dm = blob.match(/\b(0?[1-9]|[12]\d|3[01])[\-\/\.](0?[1-9]|1[0-2])[\-\/\.]((?:19|20)\d{2})\b/);
  if (dm) {
    const iso = `${dm[3]}-${String(dm[2]).padStart(2,"0")}-${String(dm[1]).padStart(2,"0")}`;
    if (isValidDateKey(iso)) dateKey = iso;
  } else {
    // "15 Oct 2024", "15-October-2024" etc
    const mmmRe = /\b(\d{1,2})\s*[- ]\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*[- ]\s*((?:19|20)\d{2})\b/i;
    const dm2 = blob.match(mmmRe);
    if (dm2) {
      const months = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
      const mm = months[dm2[2].toLowerCase()];
      const iso = `${dm2[3]}-${mm}-${String(dm2[1]).padStart(2,"0")}`;
      if (isValidDateKey(iso)) dateKey = iso;
    }
  }

  // -------- Payment method --------
  let paymentMethod = null;
  const low = blob.toLowerCase();
  if (/\b(upi|phone\s*pe|paytm|g\s*pay|google\s*pay|qr|scanner|scan\s*pay)\b/.test(low)) paymentMethod = "upi";
  else if (/\b(cash|by\s*cash|paid\s*cash|cash\s*paid|in\s*cash)\b/.test(low)) paymentMethod = "cash";
  else if (/\b(card|credit|debit|visa|master|rupay|swipe|pos)\b/.test(low)) paymentMethod = "card";
  else if (/\b(due|pending|credit|on\s*account|later|outstanding|balance)\b/.test(low)) paymentMethod = "due";
  else if (totalRupees !== null) paymentMethod = "cash";

  return {
    serviceName,
    totalRupees,
    quantity,
    rateRupees,
    customerName,
    dateKey,
    paymentMethod,
    notes: null,
    items: scannedItems(t, { serviceName, totalRupees, quantity, rateRupees }),
  };
}

/**
 * The bill as a list of line items, from raw OCR text.
 *
 * The reading above finds one amount, one date, one service — which
 * is the whole of what a one-line bill needs and a fraction of what a
 * three-line bill is. So the sold lines are read separately, and they
 * win as soon as there are two or more of them: the point of scanning
 * a bill is to book every line of it, and a keyword guess for the
 * biggest line is the wrong answer for the other two.
 *
 * Below two lines the single-item reading stands, because on a
 * one-line bill it is the more reliable of the two (it weights the
 * word "total" when picking the amount, and names the service from
 * what the shop actually sells).
 */
function scannedItems(text, single) {
  const lines = normalizeScanItems(parseReceiptLines(text));
  if (lines.length >= 2) return lines;
  return normalizeScanItems([
    {
      serviceName: single.serviceName,
      quantity: single.quantity,
      rateRupees: single.rateRupees,
      totalRupees: single.totalRupees,
    },
  ]);
}

function heuristicLineScore(line, stopRe) {
  const l = String(line || "");
  if (!l || l.length < 3) return 0;
  if (stopRe.test(l.toLowerCase())) return 0;
  // Punish lines that are mostly numbers / currency / dates
  const digits = (l.match(/\d/g) || []).length;
  const alpha = (l.match(/[A-Za-z\u0900-\u097F]/g) || []).length;
  if (alpha === 0) return 0;
  if (digits / l.length > 0.6) return 0;
  // Reward letter-heavy medium-length lines
  let score = alpha + Math.min(l.length, 40);
  if (/[A-Za-z\u0900-\u097F]\s+[A-Za-z\u0900-\u097F]/.test(l)) score += 6; // two words
  // Strip if it looks like an address or GSTIN
  if (/(gstin|c\-in|pin\s?code|phone|mobile|email|@|www\.|http|\.in|\.com)/i.test(l)) score -= 20;
  return score;
}

async function extractWithOfflineOcr(dataUrl, onProgress) {
  const text = await runTesseract(dataUrl, onProgress);
  if (onProgress) onProgress("Extracting amount, service, date, payment from text…");
  const raw = parseReceiptTextHeuristically(text);
  return normalizeAiOutput(raw);
}

/* =========================================================
   Shared: normalise AI / OCR output
   ========================================================= */

function normalizeAiOutput(raw) {
  const source = raw || {};
  const total = clampScanRupees(source.totalRupees, MAX_TOTAL_PAISE);
  const qtyRaw = Number(source.quantity);
  const qty = Number.isFinite(qtyRaw) && qtyRaw >= 1 ? Math.max(1, Math.floor(qtyRaw)) : 1;
  let rate = clampScanRupees(source.rateRupees);
  if (rate === null && total !== null) rate = Math.round((total / qty) * 100) / 100;
  if (total !== null && rate === null) rate = Math.round((total / qty) * 100) / 100;

  /* The bill as a LIST. The model is asked for `items` and for the
     same line repeated at the top level; whichever of the two it
     managed to send, the list is the answer — and a model that only
     filled in the top level still produces a one-item bill rather
     than nothing at all. */
  const items = normalizeScanItems(
    Array.isArray(source.items) && source.items.length ? source.items : [source]
  );
  /* Neither level gave a name worth reading: show the placeholder row
     rather than an empty bill, so the shopkeeper has something to fix. */
  if (!items.length) {
    items.push({
      serviceName: "Receipt item",
      quantity: qty,
      rateRupees: rate,
      totalRupees: total,
    });
  }

  /* With one line, the two descriptions have to be the same thing —
     otherwise the form would show a name the amounts belong to a
     different line. With several, the top level is the BILL's total,
     kept separate below so the two can be compared rather than
     conflated. */
  const single = items.length === 1 ? items[0] : null;

  let dateKey = null;
  if (typeof source.dateKey === "string") {
    const iso = source.dateKey.trim();
    if (isValidDateKey(iso)) dateKey = iso;
  } else if (typeof source.dateYYYYMMDD === "string") {
    const s = source.dateYYYYMMDD.trim().replace(/\//g, "-").replace(/\./g, "-");
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const iso = `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
      if (isValidDateKey(iso)) dateKey = iso;
    }
  }

  let method = null;
  if (isPaymentMethod(source.paymentMethod)) method = source.paymentMethod;
  else if (typeof source.paymentMethod === "string") {
    const s = source.paymentMethod.toLowerCase();
    if (s.includes("cash")) method = "cash";
    else if (s.includes("upi") || s.includes("phonepe") || s.includes("paytm") || s.includes("gpay")) method = "upi";
    else if (s.includes("card") || s.includes("visa") || s.includes("master")) method = "card";
    else if (s.includes("due") || s.includes("credit") || s.includes("pending")) method = "due";
  }

  let svc = typeof source.serviceName === "string" ? source.serviceName.trim() : "";
  svc = svc.replace(/\s+/g, " ").slice(0, 80);
  if (single) svc = single.serviceName;
  if (!svc) svc = "Receipt item";

  return {
    serviceName: svc,
    totalRupees: single ? single.totalRupees : total,
    quantity: single ? single.quantity : qty,
    rateRupees: single ? single.rateRupees : rate,
    /* The bill's own grand total, kept only so it can be compared
       with the sum of the lines: a bill that does not add up is a
       bill worth looking at again before it is booked. */
    billTotalRupees: clampScanRupees(source.totalRupees, MAX_TOTAL_PAISE),
    items,
    customerName: source.customerName ? String(source.customerName).trim().slice(0, 120) : null,
    dateKey,
    paymentMethod: method,
    notes: source.notes ? String(source.notes).trim().slice(0, 400) : null,
  };
}

/* ---------- Scan modal markup + build ---------- */

function scanModalMarkup() {
  const notice = aiSetupNotice();
  return (
    '<div class="scan-modal-body">' +
    (notice
      ? '<div class="alert alert-info" id="scanSetupBanner">' + escapeHtml(notice) + '</div>'
      : '<div class="alert alert-info" id="scanSetupBanner" style="display:none;"></div>') +
    '<div class="scan-stage" id="scanStage">' +
    /* ---- Stage 1: Drop zone ---- */
    '<div class="scan-dropzone" id="dropZone" role="button" tabindex="0" aria-label="Upload receipt photo">' +
    '<input type="file" id="fileInput" accept="image/*,.heic,.heif" capture="environment" class="is-hidden" />' +
    '<div class="scan-dropzone-inner">' +
    '<div class="scan-dropzone-icon">' + ICON_UPLOAD + '</div>' +
    '<h3 class="scan-dropzone-title">Upload a receipt photo</h3>' +
    '<p class="scan-dropzone-sub">Drag &amp; drop here, or tap to choose a file.<br/>' +
    '<span class="small muted">JPEG, PNG, HEIC (iPhone), WEBP — all supported.<br/>' +
    'Mode: <strong>' + escapeHtml(noKeyModeLabel()) + '</strong></span></p>' +
    '</div></div>' +
    /* ---- Stage 2: Preview + analyze (hidden until file) ---- */
    '<div class="scan-preview is-hidden" id="previewWrap">' +
    '<div class="scan-preview-head">' +
    '<button type="button" class="btn btn-ghost btn-sm" id="pickDifferentBtn">Pick different</button>' +
    '<span class="scan-preview-meta small muted" id="previewMeta"></span>' +
    '</div>' +
    '<div class="scan-preview-img" aria-hidden="true"><img id="previewImg" alt="Receipt preview" /></div>' +
    '<div class="scan-preview-actions">' +
    '<button type="button" class="btn btn-primary btn-analyze" id="analyzeBtn">' +
    ICON_SPARKLES +
    '<span>Analyze with ' + escapeHtml(noKeyModeLabel()) + '</span></button>' +
    '</div>' +
    '</div>' +
    /* ---- Stage 3: Analyzing overlay ---- */
    '<div class="scan-analyzing is-hidden" id="analyzingWrap" aria-live="polite">' +
    '<div class="scan-analyzing-inner"><span class="spinner"></span>' +
    '<h3 id="analyzingTitle">Reading receipt…</h3>' +
    '<p class="small muted" id="analyzingSub">AI is extracting service, amount, date and payment.</p></div>' +
    '</div>' +
    /* ---- Stage 4: The review, for a bill with more than one line ----
       A bill is a list, and this is where the list is shown. One row
       per line read off the paper, each with the shop's own service
       beside it, so the shopkeeper checks the reading before any of
       it reaches the ledger. Built by renderReview(). */
    '<div class="scan-review is-hidden" id="reviewWrap">' +
    '<div class="scan-review-head">' +
    '<div>' +
    '<h3 class="scan-review-title" id="reviewTitle">Lines read from the bill</h3>' +
    '<p class="small muted scan-review-sub" id="reviewSub"></p>' +
    '</div>' +
    '<div class="scan-review-headbtns">' +
    '<button type="button" class="btn btn-ghost btn-sm" id="reviewRereadBtn">Re-read</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" id="reviewOtherBtn">Other photo</button>' +
    '</div>' +
    '</div>' +
    '<div class="alert alert-error is-hidden" id="reviewMsg" role="alert"><span data-review-msg></span></div>' +
    '<div class="scan-items" id="scanItems"></div>' +
    '<div class="scan-review-foot">' +
    '<div class="scan-review-bill">' +
    '<div class="field field-bizday scan-review-day">' +
    '<label for="scanDate">Business day</label>' +
    '<input class="input" id="scanDate" type="date" />' +
    '<span class="field-hint" id="scanDayHint"></span>' +
    '</div>' +
    '<div class="field">' +
    '<label for="scanCustomer">Customer <span class="small muted">(optional)</span></label>' +
    '<input class="input" id="scanCustomer" type="text" maxlength="120" autocomplete="off" placeholder="Customer name" />' +
    '</div>' +
    '</div>' +
    '<div class="field">' +
    '<label>Payment method <span class="small muted">(for every line)</span></label>' +
    '<div class="seg-row" id="scanMethodRow" role="group" aria-label="Payment method">' +
    '<button type="button" class="seg-btn seg-cash is-active" data-method="cash">Cash</button>' +
    '<button type="button" class="seg-btn seg-upi" data-method="upi">UPI</button>' +
    '<button type="button" class="seg-btn seg-card" data-method="card">Card</button>' +
    '<button type="button" class="seg-btn seg-due" data-method="due">Due</button>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div class="entry-total" aria-live="polite">' +
    '<span class="entry-total-label">Bill total</span>' +
    '<span class="entry-total-value" id="scanTotalPreview">' + formatINR(0) + '</span>' +
    '</div>' +
    '<button type="submit" class="btn-save-txn btn-receipt-pay" id="reviewSaveBtn">' +
    ICON_SPARKLES +
    '<span>Add the lines</span></button>' +
    '</div>' +
    '</div>' +
    '</div>'
  );
}

function buildScanOverlay() {
  const el = document.createElement("div");
  el.className = "modal-overlay";
  el.id = "scanModal";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "scanModalTitle");
  el.innerHTML =
    '<div class="modal modal-lg" role="document">' +
    '<div class="modal-header">' +
    '<div class="modal-header-icon modal-header-icon-receipt" aria-hidden="true">' + ICON_CAMERA + '</div>' +
    '<div class="modal-header-text">' +
    '<h3 id="scanModalTitle">Scan receipt</h3>' +
    '<p class="modal-header-sub">Upload a bill photo — AI fills the sale, you review it.</p>' +
    '</div>' +
    '<button type="button" class="modal-close" data-close aria-label="Close">' + ICON_CLOSE + '</button>' +
    '</div>' +
    '<div class="modal-body">' + scanModalMarkup() + '</div>' +
    '</div>';
  document.body.appendChild(el);
  wireScanModal(el);
  return el;
}

/* ---------- Stage management + wiring ---------- */

function wireScanModal(root) {
  const dropZone = root.querySelector("#dropZone");
  const fileInput = root.querySelector("#fileInput");
  const pickDifferent = root.querySelector("#pickDifferentBtn");
  const analyzeBtn = root.querySelector("#analyzeBtn");

  const openPicker = () => fileInput && fileInput.click();
  dropZone.addEventListener("click", openPicker);
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
  });
  fileInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleFileChosen(f).catch((err) => toast(err.message || String(err), "error"));
    fileInput.value = "";
  });

  /* The shared modal chrome owns the close button; the review only has to
     let go of its pickers and its lines, so closing can never leave a
     half-built bill behind the next one. */
  const closeBtn = root.querySelector("[data-close]");
  if (closeBtn) closeBtn.addEventListener("click", () => clearReview());

  // Drag & drop on the whole stage so user can drop anywhere inside the modal
  const stage = root.querySelector("#scanStage");
  ["dragenter","dragover"].forEach((ev) =>
    stage.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropZone.classList.add("is-dragover");
    })
  );
  ["dragleave","drop"].forEach((ev) =>
    stage.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropZone.classList.remove("is-dragover");
    })
  );
  stage.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFileChosen(f).catch((err) => toast(err.message || String(err), "error"));
  });

  pickDifferent.addEventListener("click", () => {
    currentRawFile = null; currentDataUrl = null;
    clearReview();
    setStage(root, "dropzone");
  });

  analyzeBtn.addEventListener("click", () => onAnalyze(root));

  /* ---- The review stage's own controls ---- */
  const reread = root.querySelector("#reviewRereadBtn");
  if (reread) {
    reread.addEventListener("click", () => {
      /* Back to the same photo, not the preview: the point of this
         button is to read the picture AGAIN, usually because the first
         read was poor. Showing the preview first would be a step the
         shopkeeper did not ask for. */
      setStage(root, "analyzing");
      onAnalyze(root);
    });
  }
  const other = root.querySelector("#reviewOtherBtn");
  if (other) {
    other.addEventListener("click", () => {
      currentRawFile = null;
      currentDataUrl = null;
      currentLedgerImage = null;
      clearReview();
      setStage(root, "dropzone");
    });
  }
  const saveBtn = root.querySelector("#reviewSaveBtn");
  if (saveBtn) saveBtn.addEventListener("click", () => onSaveReview(root));

  const dateInput = root.querySelector("#scanDate");
  if (dateInput) {
    dateInput.addEventListener("change", () => {
      if (currentScan) {
        currentScan.dateKey = readReviewDate(root);
        paintReviewDay(root);
      }
    });
  }

  const methodRow = root.querySelector("#scanMethodRow");
  if (methodRow) {
    methodRow.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn || !currentScan) return;
      const method = btn.dataset.method;
      if (!isPaymentMethod(method)) return;
      currentScan.paymentMethod = method;
      methodRow.querySelectorAll(".seg-btn").forEach((b) =>
        b.classList.toggle("is-active", b === btn)
      );
    });
  }

  /* One customer for the bill. A bill either names its payer once at the
     top or does not name one at all, so this is read once at save time
     rather than copied onto every line. */
  const customerInput = root.querySelector("#scanCustomer");
  if (customerInput) {
    /* Seeded per bill in openReview(), not here: this runs while the
       overlay is being built, when there is no reading to seed from. */
    customerInput.addEventListener("input", () => {
      if (currentScan) currentScan.customerName = customerInput.value;
    });
  }
}

function setStage(root, stage) {
  const dz = root.querySelector("#dropZone");
  const prev = root.querySelector("#previewWrap");
  const analyzing = root.querySelector("#analyzingWrap");
  const review = root.querySelector("#reviewWrap");
  dz.classList.toggle("is-hidden", stage !== "dropzone");
  prev.classList.toggle("is-hidden", stage !== "preview");
  analyzing.classList.toggle("is-hidden", stage !== "analyzing");
  if (review) review.classList.toggle("is-hidden", stage !== "review");
}

function setAnalyzingText(root, title, sub) {
  const t = root.querySelector("#analyzingTitle");
  const s = root.querySelector("#analyzingSub");
  if (t && title) t.textContent = title;
  if (s && sub !== undefined) s.textContent = sub;
}

async function handleFileChosen(file) {
  if (!file) return;
  currentRawFile = file;
  /* A new photo replaces the bill being reviewed: the rows, their
     amounts and the date belong to the paper that was just dropped. */
  clearReview();
  toast("Preparing image…", "info", 1200);
  const prepared = await prepareImageForAi(file);
  currentDataUrl = prepared.dataUrl;

  /* The ledger's own copy of the photograph, rendered here while the decoded
     bitmap is to hand. It is smaller than the AI copy on purpose — this one
     is stored in Firestore — and null when even that will not fit, in which
     case the sale is simply saved without the photo. */
  currentLedgerImage = null;
  try {
    const ledgerCopy = await encodeReceiptForLedger(prepared.img);
    /* Checked again here, at the boundary, so a photo is only ever offered
       to the form if it is one the rules would accept. */
    currentLedgerImage =
      ledgerCopy && isStorableReceiptImage(ledgerCopy.dataUrl) ? ledgerCopy.dataUrl : null;
  } catch (err) {
    console.warn("[trustx-ledger] receipt copy for the ledger:", err);
  }
  /* Said out loud rather than left to be discovered: a scan that is not
     stored is not a failure of the sale, but the shopkeeper should know the
     bill will not be there to look at later. */
  if (!currentLedgerImage) {
    toast("This photo is too large to keep with the sale — it will still be read, but not stored.", "info", 3500);
  }

  const root = scanOverlay;
  const img = root.querySelector("#previewImg");
  img.src = currentDataUrl;
  const meta = root.querySelector("#previewMeta");
  const kb = Math.round(prepared.jpegBlob.size / 1024);
  meta.textContent =
    (prepared.width && prepared.height ? `${prepared.width}×${prepared.height} · ` : "") +
    `${kb >= 1024 ? (kb/1024).toFixed(1)+" MB" : kb+" KB"} · ${fileIsHeic(file) ? "converted from HEIC" : "ready"}`;
  setStage(root, "preview");
}

/* ---------- Analyze (dispatch: Gemini or offline OCR) ---------- */

async function onAnalyze(root) {
  if (analyzing) return;
  if (!currentDataUrl) { toast("Upload an image first.", "error"); return; }

  analyzing = true;
  const btn = root.querySelector("#analyzeBtn");
  setLoading(btn, true);
  setStage(root, "analyzing");
  setAnalyzingText(root, "Reading receipt…", "Extracting service, amount, date and payment.");

  const onProgress = (msg) => setAnalyzingText(root, msg || "Reading receipt…", "This usually takes 3–10 seconds.");

  try {
    const [extracted, services] = await Promise.all([
      (async () => {
        if (isGeminiConfigured()) {
          try { return await extractWithGemini(currentDataUrl, onProgress); }
          catch (geminiErr) {
            toast("Gemini failed — falling back to offline OCR.", "info", 3500);
            console.warn("[trustx-ledger] Gemini extract failed, switching to offline OCR:", geminiErr);
            return await extractWithOfflineOcr(currentDataUrl, onProgress);
          }
        }
        return await extractWithOfflineOcr(currentDataUrl, onProgress);
      })(),
      fetchServices().catch(() => []),
    ]);
    currentServices = services;
    analyzing = false;
    setLoading(btn, false);

    /* The receipt carries its own date, and for an evening shop that date is
       the useful one: a sale from Tuesday scanned on Thursday belongs to
       Tuesday. It used to be filed under today and left to the shopkeeper
       to correct afterwards, which is exactly the mistake the business-day
       field exists to remove. A date that is not in the past (a misread,
       or a receipt dated ahead) is never followed: the form refuses future
       days, so following one would only bounce. */
    const today = todayKolkata();
    const receiptDay = extracted.dateKey && extracted.dateKey < today
      ? extracted.dateKey
      : null;

    /* TWO ROUTES OUT OF A READING, because a bill is not always one
       thing. A single line goes to the record-a-sale form, exactly as
       it always has, where the shopkeeper reviews it. Several lines
       get the review list instead: they are separate sales, and
       putting them through the one-sale form would mean the shopkeeper
       writes the same bill down N times — which is the manual version
       of the problem this is meant to remove. */
    if (extracted.items.length > 1) {
      openReview(root, extracted, receiptDay, today);
      return;
    }

    const line = extracted.items[0];
    const ranked = rankCatalogMatches(line.serviceName, services);
    const match = ranked.match;
    closeModal(scanOverlay);

    /* Rate: the line's own, or derived from its total when the reading
       gave one but not the other. */
    let rateRupees = line.rateRupees;
    if (rateRupees === null && line.totalRupees !== null) {
      rateRupees = line.totalRupees / (line.quantity || 1);
    }

    openSaleForm(receiptDay ? { dateKey: receiptDay } : {});
    prefillSaleForm({
      serviceId: match ? match.serviceId : "",
      serviceNameFallback: line.serviceName || "",
      quantity: line.quantity,
      rateRupees,
      customerName: extracted.customerName,
      paymentMethod: extracted.paymentMethod,
      dateKey: receiptDay,
      /* The photograph comes with the entry, stored beside it in Firestore
         rather than in Cloud Storage: a receipt is the shop's own paper and
         belongs under the same day and the same rules as the money. */
      receiptImage: currentLedgerImage,
      /* A name the catalog does not have is not a dead end: the form
         shows what was read and the closest services to choose from. */
      scanned: match ? null : { name: line.serviceName, candidates: ranked.candidates },
    });

    if (line.totalRupees === null) {
      toast(
        "Receipt processed — total amount was unreadable. Review the form, enter ₹ amount, then save.",
        "info",
        6500
      );
    } else if (match) {
      toast(`AI matched “${match.name}” in your catalog — review and save.`, "success", 3500);
    } else {
      toast(
        `Read “${line.serviceName}” from the bill — it is not in your catalog, so pick the right service below.`,
        "info",
        5500
      );
    }

    if (receiptDay) {
      toast(
        `Receipt dated ${receiptDay} — the form is open on that business day. Change the date if the receipt is wrong.`,
        "info",
        6500
      );
    } else if (extracted.dateKey) {
      toast(
        `Receipt dated ${extracted.dateKey} is not a past day — the form is open on today (${today}). Change the business day if the receipt is right.`,
        "info",
        6500
      );
    }
  } catch (err) {
    analyzing = false;
    setLoading(btn, false);
    setStage(root, "preview");
    const msg = err && err.message ? err.message : "Could not read this receipt. Try a clearer photo.";
    toast(msg, "error", 5500);
  }
}

/* =========================================================
   THE REVIEW — a bill that came back with more than one line
   -----------------------------------------------------------------
   Every line the reading found is one sale the shop actually made, so
   the review is a LIST and the save is a batch. The alternative — N
   round trips through the one-sale form — is the same typing the
   scanner was supposed to remove, so it is not the alternative.

   What the shopkeeper sees per line:
     · the name printed on the paper, and its quantity and amount;
     · the shop's own service, matched where the reading was close
       enough to be sure, and otherwise a SEARCH box plus the closest
       catalog names as one-tap chips. A line the catalog does not have
       is a question, not a refusal;
     · the line's own rate, editable, because the bill is the price and
       the catalog's default is only a default.

   Every line is removed from the list as it lands, so a batch that
   hits a limit half way leaves exactly the unpaid lines on screen.
   ========================================================= */

/** Tear the review down: pickers released, list forgotten. */
function clearReview() {
  if (currentScan) {
    for (const row of currentScan.items) {
      if (row.picker && typeof row.picker.destroy === "function") row.picker.destroy();
    }
  }
  currentScan = null;
  savingScan = false;
  const host = scanOverlay && scanOverlay.querySelector("#scanItems");
  if (host) host.innerHTML = "";
}

/** Show the review for a multi-line bill. */
function openReview(root, extracted, receiptDay, today) {
  clearReview();

  const rows = extracted.items.slice(0, MAX_SCANNED_ITEMS).map((item, index) => {
    const ranked = rankCatalogMatches(item.serviceName, currentServices);
    return {
      item,
      /* A line the reading matched confidently is pre-selected: the
         shopkeeper can still change it, and the row says so. */
      service: ranked.match,
      /* Kept even when there is a match, because taking a choice back
         has to have something to offer — rankCatalogMatches() already
         leaves the chosen service out of its own suggestions. */
      candidates: ranked.candidates,
      index,
      el: null,
      picker: null,
    };
  });

  currentScan = {
    items: rows,
    dateKey: receiptDay || today,
    paymentMethod: isPaymentMethod(extracted.paymentMethod) ? extracted.paymentMethod : "cash",
    customerName: extracted.customerName || "",
    /* The bill's own grand total, kept only to be compared with the
       lines. A bill whose lines do not add up to its total is a bill
       that deserves a second look before it is booked. */
    billTotalPaise: extracted.billTotalRupees === null || extracted.billTotalRupees === undefined
      ? null
      : toPaise(extracted.billTotalRupees),
    receiptImage: currentLedgerImage,
  };

  const dropped = extracted.items.length - rows.length;
  if (dropped > 0) {
    toast(
      "This bill is very long — " + rows.length + " lines were read and the rest were left out. " +
      "Check nothing is missing.",
      "info",
      6000
    );
  }

  /* The payer the reading found, if any, starts in the box: the customer
     is one fact about the bill, not something to be retyped per line. */
  const customerInput = root.querySelector("#scanCustomer");
  if (customerInput) customerInput.value = currentScan.customerName;

  buildReviewRows(root);
  paintReview(root);
  setStage(root, "review");
}

/** Build the rows once. Re-painting afterwards only changes text. */
function buildReviewRows(root) {
  const host = root.querySelector("#scanItems");
  if (!host || !currentScan) return;
  host.innerHTML = "";

  currentScan.items.forEach((row) => {
    const el = document.createElement("div");
    el.className = "scan-item";
    el.innerHTML =
      '<div class="scan-item-top">' +
      '<span class="scan-item-tile" aria-hidden="true"></span>' +
      '<div class="scan-item-heads">' +
      '<p class="scan-item-name" title="Read from the bill"></p>' +
      '<p class="scan-item-read"></p>' +
      "</div>" +
      '<button type="button" class="scan-item-remove" aria-label="Remove this line from the bill">Remove</button>' +
      "</div>" +
      '<div class="scan-item-body">' +
      '<div class="scan-item-pick"></div>' +
      '<div class="scan-item-numbers">' +
      '<label class="scan-item-num"><span>Qty</span>' +
      '<input class="input input-sm" type="number" inputmode="numeric" min="1" step="1" /></label>' +
      '<label class="scan-item-num"><span>Rate (&#x20B9;)</span>' +
      '<input class="input input-sm" type="text" inputmode="decimal" placeholder="0.00" /></label>' +
      '<span class="scan-item-line" data-line-total></span>' +
      "</div>" +
      "</div>" +
      '<div class="scan-item-cands is-hidden" data-cands>' +
      '<span class="scan-item-cands-label">Not in your catalog. Pick the right one:</span>' +
      '<div class="scan-item-cands-row" data-cands-row></div>' +
      '<button type="button" class="btn btn-secondary btn-sm" data-add-service>Add it as a service</button>' +
      "</div>";
    host.appendChild(el);
    row.el = el;

    el.querySelector(".scan-item-name").textContent = row.item.serviceName;
    el.querySelector('.scan-item-remove').addEventListener("click", () => removeScanRow(root, row));

    /* The row owns the numbers the ledger will be asked to write, so
       the inputs write straight into the line item rather than being
       read back at save time: what the shopkeeper sees and what gets
       booked are then the same object, by construction. */
    const qtyInput = el.querySelector('input[type="number"]');
    const rateInput = el.querySelector('input[type="text"]');
    qtyInput.value = String(row.item.quantity);
    if (row.item.rateRupees !== null) rateInput.value = paiseToInput(toPaise(row.item.rateRupees));
    qtyInput.addEventListener("input", () => {
      const q = sanitizeQuantity(qtyInput.value);
      row.item.quantity = q === null ? 1 : q;
      paintRow(root, row);
    });
    rateInput.addEventListener("input", () => {
      const paise = rateToPaise(rateInput.value);
      row.item.rateRupees = paise === null ? null : paise / 100;
      paintRow(root, row);
    });

    const addBtn = el.querySelector("[data-add-service]");
    addBtn.addEventListener("click", () => addServiceForRow(root, row));

    /* The same searchable, grouped picker the sale form uses — one per
       line, so a bill of five lines can be checked against five
       different services. `focusAfterChoose: null` because the sale
       form's quantity box is not on screen here and must not be the
       thing that grabs focus. */
    row.picker = createServicePicker(el.querySelector(".scan-item-pick"), {
      onSelect: (service) => {
        row.service = service;
        /* Painted either way: taking a choice back has to bring the
           suggestions out again, or an undone match looks like a line
           that has been dealt with. */
        paintRow(root, row);
      },
      onCreate: (query) => addServiceForRow(root, row, query),
      focusAfterChoose: null,
    });
    row.picker.setServices(currentServices);
    if (row.service) row.picker.setValue(row.service.serviceId);

    paintRow(root, row);
  });
}

/** Take a line off the bill — a reading the shopkeeper does not believe. */
function removeScanRow(root, row) {
  if (!currentScan || !row.el) return;
  if (row.picker && typeof row.picker.destroy === "function") row.picker.destroy();
  row.picker = null;
  row.el.remove();
  row.el = null;
  clearReviewMsg(root);
  paintReview(root);
  if (!currentScan.items.some((r) => r.el)) {
    reviewMsg(root, "Every line was removed. Pick the bill again, or close this.");
  }
}

/* ---------- Painting ---------- */

/** One row: what the paper said, whether it is priced, and what to pick. */
function paintRow(root, row) {
  if (!row.el) return;
  const el = row.el;
  const paise = scanItemPaise(row.item);
  /* Two states carry meaning on a card, and they are the reason the
     styling is not merely decorative. A line with nothing chosen is a
     question the shopkeeper still has to answer; a line with no amount
     cannot be booked at all. Where both are true, the missing amount
     wins the border, because it is the one that stops the save. */
  el.classList.toggle("is-unmatched", !row.service);
  el.classList.toggle("is-unpriced", paise === null);

  el.querySelector(".scan-item-tile").textContent = row.service
    ? serviceTile(row.service)
    : serviceTile({ name: row.item.serviceName });

  const read = el.querySelector(".scan-item-read");
  read.textContent = paise === null
    ? "Read from the bill — no amount found, enter the rate"
    : "Read from the bill · " + row.item.quantity + " × " + formatINR(paise) +
      (row.service ? " · " + row.service.name : "");
  /* A dash rather than ₹0: the line has no amount, and printing zero
     would make an unfinished line look like a free one. */
  el.querySelector("[data-line-total]").textContent = paise === null ? "—" : formatINR(paise);

  /* The near-miss chips belong to the question "which of these is it?",
     so they exist only while the line is unchosen. Once the shopkeeper
     answers, the row is just a sale. */
  const cands = el.querySelector("[data-cands]");
  const candsRow = el.querySelector("[data-cands-row]");
  const showCands = !row.service && row.candidates.length > 0;
  cands.classList.toggle("is-hidden", !showCands);
  if (showCands) {
    if (!candsRow.childElementCount) {
      for (const service of row.candidates) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "btn btn-secondary btn-sm";
        chip.textContent = service.name + " · " + formatINR(service.pricePaise);
        chip.addEventListener("click", () => {
          row.picker.setValue(service.serviceId);
          paintRow(root, row);
        });
        candsRow.appendChild(chip);
      }
    }
  }
}

/** The list as a whole: what was read, what it adds up to, what to press. */
function paintReview(root) {
  if (!currentScan) return;
  const rows = currentScan.items.filter((r) => r.el);
  const { totalPaise, unpriced } = scanItemsTotal(rows.map((r) => r.item));

  const title = root.querySelector("#reviewTitle");
  if (title) {
    title.textContent = rows.length === 1
      ? "1 line read from the bill"
      : rows.length + " lines read from the bill";
  }

  const sub = root.querySelector("#reviewSub");
  if (sub) {
    const bits = ["Check each line, then add them all in one go."];
    /* The two totals side by side. When they agree the bill is
       internally consistent and the reading is probably right; when
       they do not, the shop is being told rather than left to
       discover a shortfall in the ledger. Only worth comparing once
       every line has an amount — until then the sum is knowingly
       short and the mismatch would be arithmetic, not information. */
    if (unpriced === 0 && currentScan.billTotalPaise !== null && currentScan.billTotalPaise !== totalPaise) {
      bits.push(
        "The lines add to " + formatINR(totalPaise) + " but the bill's total reads " +
        formatINR(currentScan.billTotalPaise) + " — check the lines."
      );
    }
    if (unpriced > 0) {
      bits.push(unpriced + " line" + (unpriced === 1 ? " has" : "s have") + " no amount yet.");
    }
    sub.textContent = bits.join(" ");
  }

  const preview = root.querySelector("#scanTotalPreview");
  if (preview) preview.textContent = formatINR(totalPaise);

  const btn = root.querySelector("#reviewSaveBtn");
  if (btn) {
    const label = btn.querySelector("span");
    if (label) {
      label.textContent = rows.length > 1
        ? "ADD " + rows.length + " SALES · " + formatINR(totalPaise)
        : "ADD THE SALE · " + formatINR(totalPaise);
    }
    /* Gated, and the reason is written on screen rather than left to
       be discovered on the press: a batch that books a line with no
       service, or no amount, would put a number in the ledger that
       nobody checked. */
    const ready = rows.length > 0 && !unpriced && rows.every((r) => !!r.service);
    btn.disabled = !ready || savingScan;
  }

  paintReviewDay(root);
  /* The payment buttons are lit here, not at wire time: the reading's
     guess about how the bill was paid lives on currentScan, which does
     not exist while the overlay is still being built, so painting it
     earlier would always fall back to the markup's cash button. */
  paintReviewMethod(root);
}

function readReviewDate(root) {
  const input = root.querySelector("#scanDate");
  const today = todayKolkata();
  const wanted = String((input && input.value) || "").trim();
  if (wanted && isValidDateKey(wanted) && wanted <= today) return wanted;
  return today;
}

/** Say which day the whole bill will land on, as the sale form does. */
function paintReviewDay(root) {
  if (!currentScan) return;
  const today = todayKollata();
  const input = root.querySelector("#scanDate");
  if (input) {
    input.max = today;
    if (input.value !== currentScan.dateKey) input.value = currentScan.dateKey;
  }
  const hint = root.querySelector("#scanDayHint");
  if (hint) {
    hint.textContent = currentScan.dateKey === today
      ? "Every line is booked against tonight."
      : "Every line is booked against " + currentScan.dateKey + " — a day already passed.";
  }
  const field = root.querySelector(".scan-review-day");
  if (field) field.classList.toggle("is-backfill", currentScan.dateKey < today);
}

/** Light the button for the method this bill will be saved with. */
function paintReviewMethod(root) {
  const methodRow = root.querySelector("#scanMethodRow");
  if (!methodRow || !currentScan) return;
  methodRow.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.method === currentScan.paymentMethod)
  );
}

function reviewMsg(root, text) {
  const box = root.querySelector("#reviewMsg");
  if (!box) return;
  box.classList.remove("is-hidden");
  box.querySelector("[data-review-msg]").textContent = text;
}

function clearReviewMsg(root) {
  const box = root.querySelector("#reviewMsg");
  if (box) box.classList.add("is-hidden");
}

/* ---------- Adding a service a bill named but the shop does not have ---------- */

/**
 * The bill said "Laminate A4" and the catalog has no such service.
 * Offering to add it is the other honest answer besides picking a near
 * miss, so the shop's catalog does not have to be re-typed to match
 * what the shop actually sells.
 */
async function addServiceForRow(root, row, query) {
  if (!row.el || !currentScan) return;
  const name = String(query || "").trim() || row.item.serviceName;
  /* The rate is on the bill, so it is the obvious default — but it has
     to exist, because a catalog entry with no price is a question the
     same dialog just asked. */
  if (row.item.rateRupees === null) {
    reviewMsg(root, "Enter a rate for “" + row.item.serviceName + "” first — that is the price the new service would be saved with.");
    return;
  }
  const ok = await confirm({
    title: "Add a service",
    message:
      "Add “" + name + "” to your catalog at " + formatINR(toPaise(row.item.rateRupees)) +
      " a unit?",
    confirmText: "Add it",
    variant: "primary",
  });
  if (!ok) return;
  try {
    const created = await createService({ name, price: row.item.rateRupees });
    /* The catalog cache is dropped by createService(), so this re-reads
       it and every other row on the bill sees the new service too. */
    currentServices = await fetchServices().catch(() => currentServices);
    for (const other of currentScan.items) {
      if (other.picker) other.picker.setServices(currentServices);
    }
    row.picker.setValue(created.serviceId);
    clearReviewMsg(root);
    paintRow(root, row);
    paintReview(root);
  } catch (err) {
    toast(reportError(err), "error", 5000);
  }
}

/* ---------- Saving the bill ---------- */

/** A refused write, said in words the shop can act on. */
function reviewSaveError(err) {
  if (isQuotaExhausted(err)) {
    const resetAt = quotaResetTime();
    return (
      "Today's free Firebase limit is used up, so nothing more can be saved" +
      (resetAt ? " until about " + resetAt + " today" : " for now") +
      ". The lines are still listed below — write them down, then add them after the reset."
    );
  }
  if (isNetworkError(err)) {
    return "Could not save: a sale needs a connection, and this one needs the rules to approve it. The lines below are untouched — try again when the connection is back.";
  }
  return reportError(err, { action: "sale" });
}

async function onSaveReview(root) {
  if (savingScan || !currentScan) return;
  clearReviewMsg(root);

  const rows = currentScan.items.filter((r) => r.el);
  if (!rows.length) {
    reviewMsg(root, "There is nothing left to add. Pick the bill again, or close this.");
    return;
  }
  const unchosen = rows.filter((r) => !r.service);
  if (unchosen.length) {
    reviewMsg(
      root,
      unchosen.length === 1
        ? "One line has no service yet: “" + unchosen[0].item.serviceName + "”. Pick the one it belongs to."
        : unchosen.length + " lines have no service yet. Pick one for each of them."
    );
    return;
  }
  const { unpriced } = scanItemsTotal(rows.map((r) => r.item));
  if (unpriced > 0) {
    reviewMsg(
      root,
      unpriced + " line" + (unpriced === 1 ? " has" : "s have") +
      " no rate. Enter the amount from the bill, or remove the line, before adding."
    );
    return;
  }
  /* The raw field decides, not the date readReviewDate would fall back
     to: a bill whose day was cleared by mistake must be refused, not
     quietly filed under tonight. */
  const dayField = root.querySelector("#scanDate");
  const wantedDay = String((dayField && dayField.value) || "").trim();
  const dateKey = readReviewDate(root);
  if (!isValidDateKey(wantedDay) || dateKey > todayKolkata()) {
    reviewMsg(root, "Pick a business day that has already happened.");
    if (dayField) dayField.value = currentScan.dateKey;
    return;
  }

  const saveBtn = root.querySelector("#reviewSaveBtn");
  savingScan = true;
  setLoading(saveBtn, true);
  paintReview(root);

  let saved = 0;
  let totalPaise = 0;
  let failure = null;
  /* The photograph belongs to the bill, and a document in Firestore
     belongs to one sale — so it rides with the first line and the rest
     are the amounts that were on the same paper. */
  let image = currentScan.receiptImage;

  /* One at a time, deliberately: a shop counter on a mobile connection
     is better served by three writes it can watch than by one batch it
     cannot see into, and a failure half way must not be able to lose
     the lines that had not been sent yet. */
  for (const row of rows) {
    try {
      const result = await createTransaction({
        serviceId: row.service.serviceId,
        serviceName: row.service.name,
        quantity: row.item.quantity,
        rate: row.item.rateRupees,
        paymentMethod: currentScan.paymentMethod,
        customerName: String(currentScan.customerName || "").trim(),
        dateKey,
        receiptImage: image,
      });
      image = null;
      saved += 1;
      totalPaise += result.totalPaise;
      if (row.picker && typeof row.picker.destroy === "function") row.picker.destroy();
      row.picker = null;
      row.el.remove();
      row.el = null;
    } catch (err) {
      failure = err;
      break;
    }
  }

  savingScan = false;
  setLoading(saveBtn, false);

  /* The pages behind this dialog are showing yesterday's figures, so
     they are told about every rupee that landed — including the ones
     that landed before the failure. */
  if (saved > 0) emitSaleRecorded({ dateKey, totalPaise, count: saved });

  const left = currentScan ? currentScan.items.filter((r) => r.el) : [];

  if (!left.length) {
    /* Read out of the review BEFORE it is torn down: clearReview()
       forgets the bill, and the splash still has to name what was
       saved and how it was paid for. */
    const customerName = currentScan.customerName;
    const method = currentScan.paymentMethod;
    const first = rows[0];

    closeModal(scanOverlay);
    clearReview();
    celebrateSavedSale({
      totalPaise,
      serviceName: saved === 1
        ? (first && first.service.name) || ""
        : saved + " lines from one bill",
      quantity: saved === 1 && first ? first.item.quantity : null,
      ratePaise:
        saved === 1 && first && first.item.rateRupees !== null
          ? toPaise(first.item.rateRupees)
          : null,
      customerName,
      method,
    });
    toast(
      saved + (saved === 1 ? " sale" : " sales") + " added — " + formatINR(totalPaise) +
      (dateKey !== todayKolkata() ? " on " + dateKey : "") + ".",
      "success",
      5200
    );
    return;
  }

  /* Something is still on the list, so something went wrong. The paid
     lines are gone from it, the unpaid ones are untouched, and the
     reason is on screen. */
  paintReview(root);
  const unpaid = left.map((r) => r.item.serviceName).join(", ");
  const reason = failure ? reviewSaveError(failure) : "Could not add the bill.";
  reviewMsg(
    root,
    (saved > 0 ? saved + " line" + (saved === 1 ? "" : "s") + " added. " : "") +
    reason + " Not added: " + unpaid + "."
  );
  toast(reason, "error", 6500);
}

/* ---------- Public API ---------- */

export function openScanReceiptModal() {
  if (!scanOverlay) scanOverlay = buildScanOverlay();

  currentRawFile = null;
  currentDataUrl = null;
  analyzing = false;
  /* A review left over from the last bill must not be a review the
     shopkeeper can still press save on. */
  clearReview();
  setStage(scanOverlay, "dropzone");
  const banner = scanOverlay.querySelector("#scanSetupBanner");
  if (banner) {
    const notice = aiSetupNotice();
    if (notice) { banner.style.display = ""; banner.textContent = notice; }
    else banner.style.display = "none";
  }
  const btnText = scanOverlay.querySelector("#analyzeBtn span");
  if (btnText) btnText.textContent = "Analyze with " + noKeyModeLabel();
  const fileInput = scanOverlay.querySelector("#fileInput");
  if (fileInput) fileInput.value = "";
  // Refresh the dropzone mode label too
  const dzSub = scanOverlay.querySelector(".scan-dropzone-sub strong");
  if (dzSub) dzSub.textContent = noKeyModeLabel();

  openModal(scanOverlay);
}

/* Global hotkey: Ctrl/Cmd + Shift + N = scan receipt (any page) */
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && (e.key === "N" || e.key === "n")) {
      e.preventDefault();
      openScanReceiptModal();
    }
  });
}
