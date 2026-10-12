/* =========================================================
   TrustX Ledger — Print / PDF export
   -----------------------------------------------------------------
   Every "Export PDF" button in the app opens the browser's own
   print dialog, where the shopkeeper picks "Save as PDF" or sends
   the sheet to a printer. That is deliberate: the browser already
   makes a PDF, works with no network, and needs nothing added to
   a project that ships zero dependencies and no build step.

   What is left for us is to make the sheet worth printing:

     - this module, which draws a print-only letterhead (shop,
       report, business day, when it was printed) into the page, and
     - css/print.css, which strips the sidebar, topbar, filters and
       row-action buttons so what comes out is a document rather
       than a screenshot of an app.

   The letterhead lives here, not in each page, so the daily ledger
   and the transaction history print the same header. The values
   are written from live state at the moment of printing, so the
   paper always describes the day and the filters it came from.
   ========================================================= */

import { formatKolkataLong, formatKolkataTime } from "./utils.js";

/** A printer, for the Export button on the report pages. */
export const ICON_PRINT =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>';

/**
 * The print-only letterhead.
 *
 * It is `display: none` on screen (css/print.css) and the first thing
 * on the printed page, so an export reads as a report and not as a
 * photograph of the app. The empty elements are filled by
 * `printExport()` from live state, never written into the HTML.
 */
export function printHeaderMarkup() {
  return (
    '<header class="print-doc" aria-hidden="true">' +
      '<img class="print-doc-logo" src="assets/logo.svg" alt="" width="40" height="40" />' +
      '<div class="print-doc-identity">' +
        '<div class="print-doc-shop" id="printShop"></div>' +
        '<div class="print-doc-app">TrustX Ledger</div>' +
      '</div>' +
      '<div class="print-doc-title">' +
        '<div class="print-doc-report" id="printReport"></div>' +
        '<div class="print-doc-sub" id="printSub"></div>' +
        '<div class="print-doc-meta" id="printMeta"></div>' +
        '<div class="print-doc-stamp" id="printStamp"></div>' +
      '</div>' +
    '</header>'
  );
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/**
 * Fill the letterhead from live state and open the print dialog.
 *
 * The dialog is the browser's, so its paper size, "Save as PDF" and
 * print-preview all come for free; this only makes sure the sheet
 * says what it is.
 *
 * @param {object} o
 * @param {string} [o.shopName] the shop's own name, from the shop record
 * @param {string} [o.report]   report title, e.g. "Daily ledger"
 * @param {string} [o.subtitle] the day or scope the sheet covers
 * @param {string} [o.meta]     row count and any active filter
 */
export function printExport({ shopName = "", report = "", subtitle = "", meta = "" } = {}) {
  const now = new Date();
  setText("printShop", String(shopName || "").trim() || "TrustX Ledger");
  setText("printReport", report);
  setText("printSub", subtitle);
  setText("printMeta", meta);
  setText("printStamp", "Printed " + formatKolkataLong(now) + " · " + formatKolkataTime(now));
  /* The values above are already in the DOM when print() runs, and the
     browser re-lays-out for print media as it opens the dialog, so no
     paint has to be forced first. */
  window.print();
}
