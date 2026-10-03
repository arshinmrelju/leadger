/* =========================================================
   TrustX Ledger — AI / LLM configuration (FREE providers only)
   -----------------------------------------------------------------
   TWO PATHS — neither costs money, neither needs a credit card:

   1. GOOGLE GEMINI (recommended, free tier)
      - Sign up at https://aistudio.google.com/ with any Google account
      - Go to "Get API key" → "Create API key"
      - NO credit card / billing is ever requested for the free tier
      - Free limits (as of 2026): 1,500 requests/day, 15 RPM, 1M tokens/day
        — plenty for a small shop.
      - Restrict the key in Google Cloud Console → API Keys if you want
        (HTTP referrer restriction to your hosting domain).

   2. FULLY OFFLINE OCR (no API key at all)
      - If you leave `geminiApiKey` as the placeholder, the app will
        automatically load Tesseract.js from a CDN on first use, run OCR
        100% in the browser (no data leaves your device), then parse
        the resulting text with Indian-receipt regex heuristics.
      - Accurate enough for clearly printed receipts; handwriting is
        hit-or-miss compared to Gemini. Works offline after the first
        time Tesseract's ~10 MB English model is cached.

   Receipt images are processed for extraction, and the photo itself is kept
   with the sale in Firestore (dayHeads/{dateKey}/receiptImages/{txnId}) — not
   in Cloud Storage, which this project does not use. The stored copy is
   re-encoded smaller than the AI copy, because it has to fit inside a 1 MiB
   Firestore document as base64.
   ========================================================= */

export const AI_CONFIG = {
  /* ---------------- Primary: Google Gemini 1.5 Flash ---------------- */
  geminiApiKey: "YOUR_GEMINI_API_KEY_HERE",
  geminiModel: "gemini-1.5-flash",
  /* Google AI Studio endpoint (public, no OAuth; API key in query string). */
  geminiEndpoint: "https://generativelanguage.googleapis.com/v1beta",

  /* ---------------- Shared image preprocessing ---------------- */
  maxImageSizeMb: 3.5,
  downscaleLongEdge: 1400,
  jpegQuality: 0.82,

  /* ---------------- The copy stored with the sale ----------------
     Smaller than the AI copy on purpose. The stored photo lives in a
     Firestore document (base64 costs 4/3 on top of the JPEG) and a bill only
     has to stay readable on a phone screen. */
  storeLongEdge: 1000,
  storeJpegQuality: 0.72,
};

const PLACEHOLDER_TOKENS = ["YOUR_", "XXXXXXXX", "xxxx"];

export function isGeminiConfigured() {
  const k = AI_CONFIG.geminiApiKey;
  return (
    typeof k === "string" &&
    k.trim().length > 10 &&
    !PLACEHOLDER_TOKENS.some((t) => k.includes(t))
  );
}

export function aiSetupNotice() {
  if (isGeminiConfigured()) return null;
  return (
    "Running in fully-offline OCR mode. For better accuracy on handwriting " +
    "and messy photos, paste a FREE Google Gemini key into js/ai-config.js " +
    "(get one at aistudio.google.com — no credit card required)."
  );
}

export function noKeyModeLabel() {
  return isGeminiConfigured() ? "Gemini AI" : "Offline OCR";
}
