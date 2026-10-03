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
     6. Match serviceName against catalog, pre-fill existing sale form
        → user reviews and saves.

   Receipt images are NOT stored after processing.
   ========================================================= */

import { toast, setLoading, openModal, closeModal } from "./app.js";
import {
  todayKolkata,
  isValidDateKey,
  escapeHtml,
  isPaymentMethod,
} from "./utils.js";
import { fetchServices } from "./ledger.js";
import { openSaleForm, prefillSaleForm } from "./sale-form.js";
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
let currentServices = [];
let analyzing = false;

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
  return prepared;
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

function downscaleToJpeg(img) {
  const maxEdge = AI_CONFIG.downscaleLongEdge;
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
        const sizeMb = blob.size / (1024 * 1024);
        if (sizeMb > AI_CONFIG.maxImageSizeMb * 1.2) {
          return reject(
            new Error(
              "Image is too large after resize (" + sizeMb.toFixed(1) + " MB). Try a smaller photo."
            )
          );
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read image data."));
        reader.onload = () =>
          resolve({ jpegBlob: blob, dataUrl: reader.result, width: w, height: h });
        reader.readAsDataURL(blob);
      },
      "image/jpeg",
      AI_CONFIG.jpegQuality
    );
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
  "serviceName": string,       short human-readable service (e.g. "Photocopy A4", "Passport form", "Mobile recharge"). 2-60 chars.
  "totalRupees": number|null,  billed total in RUPEES (not paise). ₹250 → 250. ₹15.50 → 15.5
  "quantity": number,          integer ≥ 1. Use 1 if unclear.
  "rateRupees": number|null,   per-unit price; if unknown derive as total/quantity.
  "customerName": string|null, payer name if written, else null.
  "dateYYYYMMDD": string|null, receipt date as "YYYY-MM-DD" (Asia/Kolkata). Use null if illegible.
  "paymentMethod": "cash"|"upi"|"card"|"due"|null,
  "notes": string|null         any extra lines worth keeping (short, < 400 chars)
}

Rules:
- Multi-item receipts: summarise serviceName to the largest / primary line item.
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
      maxOutputTokens: 500,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
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
        required: ["serviceName", "quantity"],
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
  };
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
   Shared: normalise AI / OCR output + catalog matching
   ========================================================= */

function clampRupees(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1000000) return null;
  return Math.round(n * 100) / 100;
}

function normalizeAiOutput(raw) {
  const total = clampRupees(raw.totalRupees);
  const qtyRaw = Number(raw.quantity);
  const qty = Number.isFinite(qtyRaw) && qtyRaw >= 1 ? Math.max(1, Math.floor(qtyRaw)) : 1;
  let rate = clampRupees(raw.rateRupees);
  if (rate === null && total !== null) rate = Math.round((total / qty) * 100) / 100;
  if (total !== null && rate === null) rate = Math.round((total / qty) * 100) / 100;

  let dateKey = null;
  if (typeof raw.dateKey === "string") {
    const iso = raw.dateKey.trim();
    if (isValidDateKey(iso)) dateKey = iso;
  } else if (typeof raw.dateYYYYMMDD === "string") {
    const s = raw.dateYYYYMMDD.trim().replace(/\//g, "-").replace(/\./g, "-");
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const iso = `${m[1]}-${String(m[2]).padStart(2,"0")}-${String(m[3]).padStart(2,"0")}`;
      if (isValidDateKey(iso)) dateKey = iso;
    }
  }

  let method = null;
  if (isPaymentMethod(raw.paymentMethod)) method = raw.paymentMethod;
  else if (typeof raw.paymentMethod === "string") {
    const s = raw.paymentMethod.toLowerCase();
    if (s.includes("cash")) method = "cash";
    else if (s.includes("upi") || s.includes("phonepe") || s.includes("paytm") || s.includes("gpay")) method = "upi";
    else if (s.includes("card") || s.includes("visa") || s.includes("master")) method = "card";
    else if (s.includes("due") || s.includes("credit") || s.includes("pending")) method = "due";
  }

  let svc = typeof raw.serviceName === "string" ? raw.serviceName.trim() : "";
  svc = svc.replace(/\s+/g, " ").slice(0, 80);
  if (!svc) svc = "Receipt item";

  return {
    serviceName: svc,
    totalRupees: total,
    quantity: qty,
    rateRupees: rate,
    customerName: raw.customerName ? String(raw.customerName).trim().slice(0, 120) : null,
    dateKey,
    paymentMethod: method,
    notes: raw.notes ? String(raw.notes).trim().slice(0, 400) : null,
  };
}

/**
 * Fuzzy match AI-extracted serviceName → catalog.
 * Returns matched service or null.
 */
function matchAiServiceToCatalog(aiServiceName, services) {
  if (!aiServiceName || !services.length) return null;
  const q = aiServiceName.toLowerCase().replace(/[^a-z0-9\u0900-\u097F\s]/g, "").trim();
  if (!q) return null;
  const qTokens = new Set(q.split(/\s+/).filter(Boolean));

  let best = null;
  let bestScore = 0;
  for (const s of services) {
    const n = String(s.name || "").toLowerCase().replace(/[^a-z0-9\u0900-\u097F\s]/g, "").trim();
    if (!n) continue;
    let score = 0;
    if (n === q) score = 1000;
    else if (n.startsWith(q) || q.startsWith(n)) score = 400;
    else if (n.includes(q) || q.includes(n)) score = 200;
    else {
      const nTokens = new Set(n.split(/\s+/).filter(Boolean));
      let overlap = 0;
      for (const t of qTokens) if (nTokens.has(t) && t.length >= 2) overlap += t.length;
      score = overlap * 6;
    }
    if (score > bestScore) { bestScore = score; best = s; }
  }
  if (bestScore >= 24) return best;
  return null;
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
    setStage(root, "dropzone");
  });

  analyzeBtn.addEventListener("click", () => onAnalyze(root));
}

function setStage(root, stage) {
  const dz = root.querySelector("#dropZone");
  const prev = root.querySelector("#previewWrap");
  const analyzing = root.querySelector("#analyzingWrap");
  dz.classList.toggle("is-hidden", stage !== "dropzone");
  prev.classList.toggle("is-hidden", stage !== "preview");
  analyzing.classList.toggle("is-hidden", stage !== "analyzing");
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
  toast("Preparing image…", "info", 1200);
  const prepared = await prepareImageForAi(file);
  currentDataUrl = prepared.dataUrl;

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
    const match = matchAiServiceToCatalog(extracted.serviceName, services);
    analyzing = false;
    setLoading(btn, false);
    closeModal(scanOverlay);

    // Rate: AI-returned, or derive from total / qty if missing
    let rateRupees = extracted.rateRupees;
    if (rateRupees === null && extracted.totalRupees !== null) {
      rateRupees = extracted.totalRupees / (extracted.quantity || 1);
    }

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

    openSaleForm(receiptDay ? { dateKey: receiptDay } : {});
    prefillSaleForm({
      serviceId: match ? match.serviceId : "",
      serviceNameFallback: extracted.serviceName || "",
      quantity: extracted.quantity,
      rateRupees,
      customerName: extracted.customerName,
      paymentMethod: extracted.paymentMethod,
      dateKey: receiptDay,
    });

    if (extracted.totalRupees === null) {
      toast(
        "Receipt processed — total amount was unreadable. Review the form, enter ₹ amount, then save.",
        "info",
        6500
      );
    } else if (match) {
      toast(`AI matched “${match.name}” in your catalog — review and save.`, "success", 3500);
    } else {
      toast("Receipt read. Pick a matching service (or add one), then save.", "info", 4500);
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

/* ---------- Public API ---------- */

export function openScanReceiptModal() {
  if (!scanOverlay) scanOverlay = buildScanOverlay();

  currentRawFile = null;
  currentDataUrl = null;
  analyzing = false;
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
