/* =========================================================
   TrustX Ledger — Ledger data layer
   -----------------------------------------------------------------
   SPLIT ACROSS TWO DATABASES, ONE PROJECT.

   Cloud Firestore holds the ledger and the service catalog.
   Transactions are day-partitioned — the business day IS the path:
     dayHeads/{dateKey}                       the day head: state, open/close
                                             timestamps, and running counters
     dayHeads/{dateKey}/transactions/{txnId}  the sales for that day only
     services/{serviceId}                     the quick-service catalog

   One busy day can never slow down another; reading a day's sales needs
   no composite index; and the catalog lives alongside the ledger so a
   Firestore rule can verify a service name on every write.

   Realtime Database holds everything the money does not need to sit
   next to — shop identity, the two codes, device registry, and expenses:
     settings/{general,security,admin}   shop identity and the two codes
     enrollments/{nonce}                 one-time device proofs
     devices/{tokenHash}                 trusted-device registry
     expenses/{dateKey}/{expId}          spends recorded on a business day

   Two consequences worth knowing before reading the code:
     * A sale and the day's counters are written in ONE atomic batch,
       and firestore.rules checks the head moved by exactly that sale.
       A sale therefore cannot land without the day's totals following.
     * The catalog is in the same database as transactions, so the rules
       CAN verify the service name on every sale write.

   All money is integer paise. Dates are Asia/Kolkata `YYYY-MM-DD`.
   Reads only touch the day being viewed — never the whole store.
   ========================================================= */

import { getFirebridge } from "./firebase.js";
import {
  todayKolkata,
  uid,
  isValidDateKey,
  sanitizeQuantity,
  rateToPaise,
  computeTotalPaise,
  isPaymentMethod,
  statusForMethod,
  methodLabel,
  RECEIPT_IMAGE_PREFIX,
  RECEIPT_IMAGE_MAX_BYTES,
  receiptImageBytes,
} from "./utils.js";
import { findMissingCatalogServices } from "./service-catalog.js";
import { monthBounds, currentYearMonth } from "./calendar.js";
import {
  DAY_STATE,
  emptyCounters,
  splitAmounts,
  amountsFromDoc,
  isCounterSetValid,
} from "./day-heads.js";
import { createReadCache } from "./read-cache.js";
import {
  guardQuota,
  isQuotaExhausted,
  noteReads,
  noteWrites,
  noteDeletes,
  readsForQuery,
} from "./quota.js";

function toSafe(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toPaiseInt(value) {
  return Math.max(0, Math.round(toSafe(value)));
}

/* ------------------------------------------------------------------
   Bridge access
   ------------------------------------------------------------------ */

/** The Firebase bridge, with both databases resolved. */
async function bridge() {
  const b = await getFirebridge();
  if (!b) throw new Error("Firebase is not configured yet. Add your web app config in js/firebase.js.");
  return b;
}

/**
 * The Realtime Database handle, or a thrown error the UI can show.
 * Kept separate from `bridge()` on purpose: the ledger itself lives in
 * Firestore, so a broken databaseURL must not stop sales from being
 * recorded — only the catalog, expenses and device registry degrade.
 */
async function rtdbBridge() {
  const b = await bridge();
  if (!b.rtdb) {
    throw new Error(
      "Realtime Database is not reachable. Check databaseURL in js/firebase.js and that database.rules.json is deployed."
    );
  }
  return b;
}

/* ------------------------------------------------------------------
   Free-plan accounting and read caching
   ------------------------------------------------------------------
   The shop is on the Spark plan: 50,000 reads, 20,000 writes and 20,000
   deletes a DAY, with no billing account behind it to warn us first. Two
   habits below keep a busy counter nowhere near those walls.

   One, every read is counted (noteReads) so the Developer console can show
   how close the day is to the edge. It is an estimate, and the rules'
   own `trusted()` lookup is folded into readsForQuery so it does not
   flatter the number.

   Two, display reads go through a read-through cache. A read served from
   the local Firestore cache is not billed, so re-showing a day the shop
   looked at a minute ago costs nothing. Writes never use it: a sale always
   re-reads its day head from the server, because firestore.rules verifies
   the counter delta against the REAL pre-write state and a cached head
   would quietly break the one guarantee the ledger makes. */

const readCacheError = (err) => {
  /* A failed background refresh is not worth a page-level error: the
     caller already has a value, and the next read retries. */
  console.warn("[trustx-ledger] background refresh failed:", err);
};

/** Shop identity, catalog. Changes only when an admin edits it. */
const catalogCache = createReadCache({
  freshTtlMs: 30_000,
  staleTtlMs: 5 * 60_000,
  onError: readCacheError,
  persist: "catalog",
});

/**
 * Day heads. This is the number the dashboard shows, so the fresh window is
 * short: a sale on another device should show up almost immediately. The
 * stale window is longer, and only means "painted instantly, corrected a
 * moment later" — the write path never reads through here.
 */
const headCache = createReadCache({
  freshTtlMs: 15_000,
  staleTtlMs: 60_000,
  onError: readCacheError,
});

/**
 * The transaction lists and the all-time history walk.
 *
 * The only cache here that persists across a page load, and the one that
 * most needs to be: the all-time walk is the most expensive read in the
 * app — one query per day head it opens, each with a rules grant lookup
 * behind it — and re-buying it in full on every refresh is the read budget
 * going nowhere. Safe to persist because what is stored is plain,
 * normalized rows: exactly what the server returned, never a part-filled
 * local Firestore cache.
 */
const historyCache = createReadCache({
  freshTtlMs: 15_000,
  staleTtlMs: 60_000,
  onError: readCacheError,
  persist: "history",
});

/**
 * One day's first page.
 *
 * Deliberately NOT persisted, unlike historyCache: the page's continuation
 * cursor is a live Firestore document snapshot, which has no serialised form
 * worth keeping and would come back as something that merely looks like a
 * cursor. It is also a single query, so the cross-reload saving is not worth
 * a corrupted "next page".
 */
const rowsCache = createReadCache({
  freshTtlMs: 15_000,
  staleTtlMs: 60_000,
  onError: readCacheError,
});

/** Expenses live in the Realtime Database and are metered by bandwidth. */
const expensesCache = createReadCache({
  freshTtlMs: 60_000,
  staleTtlMs: 5 * 60_000,
  onError: readCacheError,
  persist: "expenses",
});

/**
 * One month of day heads — the calendar.
 *
 * Persisted, because a month is the second-most expensive thing to read
 * after the all-time walk and it is looked at repeatedly: the shop opens
 * it to check whether tonight is written up, then again to catch up the
 * days it missed. What is stored is a plain dateKey -> counters map, so
 * it is exactly what the server returned and never a part-filled local
 * Firestore cache.
 */
const monthCache = createReadCache({
  freshTtlMs: 60_000,
  staleTtlMs: 10 * 60_000,
  onError: readCacheError,
  persist: "month",
});

/* A catalog edit in one tab has to reach the others. The Developer console
   is rarely the same tab that is selling, so re-check whenever this tab
   comes back to the front — cheap next to re-reading the whole catalog. */
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("focus", () => catalogCache.drop());
}

/** A counted, quota-classified single-document read. */
function chargedGetDoc(fs, ref, options) {
  return guardQuota(async () => {
    const snap = await fs.getDoc(ref, options);
    noteReads(readsForQuery(snap.exists() ? 1 : 0));
    return snap;
  });
}

/**
 * A counted, quota-classified query.
 *
 * Every query reaches the server, so every query is billed — the free
 * local cache is not something this app can lean on for this, because a
 * query whose first page has never been fetched on this device returns
 * nothing rather than a miss. Keeping a short-lived read-through cache in
 * front (see rowsCache above) is what actually stops repeat views paying
 * twice for the same walk; this function exists so that whatever does reach
 * the server is counted and classified on the way through.
 */
function chargedGetDocs(fs, query) {
  return guardQuota(async () => {
    const snap = await fs.getDocs(query);
    noteReads(readsForQuery(snap.size));
    return snap;
  });
}

/* ------------------------------------------------------------------
   Day-head and sale paths
   ------------------------------------------------------------------ */

function headRef(fs, db, dateKey) {
  return fs.doc(db, "dayHeads", dateKey);
}

function dayTxnsRef(fs, db, dateKey) {
  return fs.collection(db, "dayHeads", dateKey, "transactions");
}

function txnRef(fs, db, dateKey, txnId) {
  return fs.doc(db, "dayHeads", dateKey, "transactions", txnId);
}

/**
 * The receipt photo's own document, beside the sale it belongs to.
 *
 * Separate from the sale on purpose: a base64 JPEG is 4/3 the size of the
 * image and can run to hundreds of KB, so keeping it on the sale would mean
 * every listing of the day downloaded a photograph nobody asked for. Read
 * only when someone opens it (fetchReceiptImage).
 */
function receiptImageRef(fs, db, dateKey, txnId) {
  return fs.doc(db, "dayHeads", dateKey, "receiptImages", txnId);
}

/* ------------------------------------------------------------------
   Normalizers — one trusted shape for the UI.
   The single-method transaction model (Part 4) is primary; legacy
   docs written with the old split-field shape are mapped defensively.
   ------------------------------------------------------------------ */

function normalizeTxn(id, raw, dateKey = "") {
  const totalPaise = toPaiseInt(raw.total ?? raw.amountPaise);

  let paymentMethod;
  if (isPaymentMethod(raw.paymentMethod)) {
    paymentMethod = raw.paymentMethod;
  } else {
    paymentMethod = toPaiseInt(raw.cashPaise) > 0
      ? "cash"
      : toPaiseInt(raw.upiPaise) > 0
        ? "upi"
        : toPaiseInt(raw.cardPaise) > 0
          ? "card"
          : toPaiseInt(raw.duePaise) > 0
            ? "due"
            : "cash";
  }

  const isDue = paymentMethod === "due";
  const collectedPaise = isDue ? 0 : totalPaise;
  const duePaise = isDue ? totalPaise : 0;

  let status;
  if (raw.status === "paid" || raw.status === "pending") status = raw.status;
  else status = isDue ? "pending" : raw.status === "DUE" || raw.status === "PARTIAL" ? "pending" : "paid";

  let serviceName = String(raw.serviceName || "").trim();
  if (!serviceName) {
    const items = Array.isArray(raw.items) && raw.items.length ? raw.items : [];
    serviceName = items.slice(0, 1).map((i) => i.name || "Service").join(", ") || String(raw.service || raw.title || "Service");
  }

  return {
    txnId: id,
    /* `dateKey` lives on the PARENT day head, not on the sale document, so
       `...raw` cannot supply it. Every write path is addressed by
       (dateKey, txnId) - deleteTransaction, updateTransaction and
       markTransactionPaid all refuse an invalid dateKey - so a row without it
       cannot be edited, deleted or settled at all. It is set after the spread
       so a stray field on a legacy document can never shadow the real day. */
    ...raw,
    dateKey: String(dateKey || raw.dateKey || ""),
    serviceName,
    serviceId: String(raw.serviceId || ""),
    quantity: toSafe(raw.quantity),
    ratePaise: toPaiseInt(raw.rate),
    totalPaise,
    paymentMethod,
    methodLabel: methodLabel(paymentMethod),
    collectedPaise,
    duePaise,
    status,
    /* Whether a receipt photo is on file for this sale. Read from the sale
       document rather than probed: a boolean is free to list, while checking
       would cost a read per row. */
    hasReceipt: raw.hasReceipt === true,
    customerId: String(raw.customerId || ""),
    customerName: String(raw.customerName || raw.customer || ""),
    customerPhone: String(raw.customerPhone || ""),
  };
}

function normalizeExpense(dateKey, id, raw) {
  return {
    expId: id,
    ...raw,
    date: String(raw.date || dateKey || ""),
    title: String(raw.title || raw.name || "Expense").trim(),
    amountPaise: toPaiseInt(raw.amountPaise),
  };
}

function normalizeService(id, raw) {
  return {
    serviceId: id,
    ...raw,
    name: String(raw.name || "").trim() || "Service",
    pricePaise: toPaiseInt(raw.pricePaise),
    active: raw.active !== false,
    sortOrder: toSafe(raw.sortOrder),
  };
}

function emptySummary() {
  return {
    transactions: [],
    count: 0,
    amountPaise: 0,
    paidPaise: 0,
    cashPaise: 0,
    upiPaise: 0,
    cardPaise: 0,
    duePaise: 0,
    expensesPaise: 0,
    netPaise: 0,
  };
}

/** Turn a head's counters into the summary shape the dashboard renders. */
function summaryFromCounters(dateKey, counters) {
  const summary = emptySummary();
  summary.count = toSafe(counters.txnCount);
  summary.amountPaise = toPaiseInt(counters.grossPaise);
  summary.cashPaise = toPaiseInt(counters.cashPaise);
  summary.upiPaise = toPaiseInt(counters.upiPaise);
  summary.cardPaise = toPaiseInt(counters.cardPaise);
  summary.duePaise = toPaiseInt(counters.duePaise);
  summary.paidPaise = toPaiseInt(counters.collectedPaise);
  summary.netPaise = summary.paidPaise;
  /* Not carried on the head, but every consumer already treats these
     two as dates, and a day with no head is still a day. */
  summary.dateKey = dateKey;
  return summary;
}

/** Fold rows into a summary — the fallback path when the head is unreadable. */
function summaryFromRows(rows, expensesPaise) {
  const summary = emptySummary();
  summary.transactions = rows;
  summary.count = rows.length;
  for (const t of rows) {
    summary.amountPaise += t.totalPaise;
    summary.paidPaise += t.collectedPaise;
    summary.duePaise += t.duePaise;
    if (t.paymentMethod === "cash") summary.cashPaise += t.totalPaise;
    else if (t.paymentMethod === "upi") summary.upiPaise += t.totalPaise;
    else if (t.paymentMethod === "card") summary.cardPaise += t.totalPaise;
  }
  summary.expensesPaise = expensesPaise;
  summary.netPaise = summary.paidPaise - summary.expensesPaise;
  return summary;
}

/* ------------------------------------------------------------------
   Realtime Database reads (catalog + expenses)
   ------------------------------------------------------------------ */

/**
 * Best-effort read of the quick-service catalog from Firestore, active first.
 *
 * Cache-first, because this is a whole-collection read with no limit and
 * the picker, the sale form, the transaction editor and the Developer
 * console all ask for it. It changes only when somebody edits the catalog,
 * so a five-minute recheck keeps it current while turning a page load that
 * used to cost a read per catalog entry into no read at all.
 *
 * The cache is dropped on window focus and by every catalog write below,
 * so an edit lands in a selling tab on its next read.
 */
export async function fetchServices({ includeInactive = false, force = false } = {}) {
  const b = await bridge();
  const fs = b.firestore;

  const all = await catalogCache.read(
    "all",
    async () => {
      const snap = await chargedGetDocs(fs, fs.collection(b.db, "services"));
      return snap.docs.map((d) => normalizeService(d.id, d.data()));
    },
    { force }
  );

  const list = all.slice().sort(
    (x, y) =>
      (x.active ? 0 : 1) - (y.active ? 0 : 1) ||
      x.sortOrder - y.sortOrder ||
      String(x.name).localeCompare(String(y.name))
  );
  return includeInactive ? list : list.filter((s) => s.active);
}

/**
 * Read one day's expenses from its Realtime Database bucket.
 *
 * Guarded and classified like the Firestore reads, even though RTDB is
 * metered by bandwidth rather than by a daily count: the failure this
 * prevents is that an out-of-bandwidth refusal gets reported as an ordinary
 * offline blip, so the shop believes its expenses are simply empty rather
 * than that the app has hit a wall.
 */
async function readExpensesForDay(dateKey) {
  const b = await rtdbBridge();
  const rt = b.rtdbMod;
  return expensesCache.read(`day:${dateKey}`, () =>
    guardQuota(async () => {
      const snap = await rt.get(rt.ref(b.rtdb, "expenses", dateKey));
      const raw = snap.val() || {};
      return Object.keys(raw).map((id) => normalizeExpense(dateKey, id, raw[id]));
    })
  );
}

/**
 * Read expenses for the Developer console.
 *
 * Expenses are bucketed by day in the Realtime Database, so a single day
 * is one straight read. With no `dateKey`, the most recent DAYS buckets
 * are read and flattened — Realtime Database orders object keys, so the
 * newest days come first with no index and no query language involved.
 *
 * The one query already downloads every field of every bucket it returns,
 * so the rows are normalized straight out of that payload. Reading each day
 * again afterwards would ask the network for bytes it had already sent —
 * thirty round-trips and roughly double the download for an identical
 * answer.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.dateKey] a single `YYYY-MM-DD`, or null for recent days
 * @param {number} [opts.limit]        cap on returned rows
 * @param {number} [opts.days]         how many recent days to span
 */
export async function fetchExpenses({ dateKey = null, limit = 200, days = 30 } = {}) {
  if (dateKey) {
    if (!isValidDateKey(dateKey)) return [];
    const rows = await readExpensesForDay(dateKey);
    return rows.slice(0, limit);
  }

  const b = await rtdbBridge();
  const rt = b.rtdbMod;
  /* One query for the day buckets, then normalize from the payload it
     already returned. See the note on fetchExpenses. */
  const buckets = await expensesCache.read(`recent:${days}`, () =>
    guardQuota(async () => {
      const snap = await rt.get(
        rt.query(rt.ref(b.rtdb, "expenses"), rt.orderByKey(), rt.limitToLast(days))
      );
      return snap.val() || {};
    })
  );

  const flat = [];
  for (const dateKey of Object.keys(buckets).sort()) {
    const raw = buckets[dateKey] || {};
    for (const id of Object.keys(raw)) flat.push(normalizeExpense(dateKey, id, raw[id]));
  }
  /* Newest day first, matching the transactions browser beside it. */
  flat.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  return flat.slice(0, limit);
}

/** Total recorded against one day, for the summary fallback. */
async function expensesTotalForDay(dateKey) {
  const rows = await readExpensesForDay(dateKey);
  return rows.reduce((sum, e) => sum + e.amountPaise, 0);
}

/* ------------------------------------------------------------------
   Day reads (Firestore)
   ------------------------------------------------------------------ */

/**
 * One-shot summary of a single business day (default: today in India).
 *
 * The day head answers "how did today go?" from a single document, so
 * the dashboard no longer has to read every sale to draw a total. When
 * the head cannot be read — a brand new day that has never been fetched
 * locally, or a browser that is offline — the day's rows are folded
 * instead, so the numbers on screen are never worse than they were
 * before the day was given a head. Expenses come from the Realtime
 * Database and are subtracted either way.
 *
 * NET = today's collections (cash + UPI + card) − today's expenses.
 * Dues are money not yet received and are excluded from NET.
 */
export async function fetchTodaySummary(dateKey = todayKolkata()) {
  const b = await bridge();
  const fs = b.firestore;

  if (!isValidDateKey(dateKey)) {
    throw new Error("Pick a valid date to view the summary.");
  }

  /* Expenses first: they live on the other database, so a Realtime
     Database problem should not also cost us the day's totals. */
  let expensesPaise = 0;
  try {
    expensesPaise = await expensesTotalForDay(dateKey);
  } catch (err) {
    /* A spent quota is not "this day had no expenses". Swallowing it here
       would put a confidently wrong NET in front of the shopkeeper — the
       number would include expenses that were never subtracted — and the
       banner would never appear, because the one caller that could report
       it has just thrown the error away. */
    if (isQuotaExhausted(err)) throw err;
    console.warn("[trustx-ledger] expenses unavailable for the summary:", err);
  }

  let head = null;
  try {
    /* Cache-first: re-opening the dashboard should not re-buy the same
       head. The fresh window is short, so a sale made on another device
       shows up almost immediately; the stale window is longer, and only
       means "painted off the last known value, corrected a moment later".
       The write path never reads through here.
       The key is shared with countDayTransactions() — they are the same
       document, and two keys for one doc would mean paying twice for it. */
    head = await headCache.read(`head:${dateKey}`, () =>
      chargedGetDoc(fs, headRef(fs, b.db, dateKey))
    );
  } catch (err) {
    /* A spent daily quota is not a missing head. Folding the rows here
       would read every sale on the day — the single most expensive thing
       this app can do, at exactly the moment it can least afford it — and
       then show a shopkeeper a confidently wrong total because some of
       those reads failed too. Surface the real reason instead. */
    if (isQuotaExhausted(err)) throw err;
    /* Offline with a never-fetched day: fall through to the rows. */
    console.warn("[trustx-ledger] day head unavailable, folding rows instead:", err);
  }

  if (head && head.exists()) {
    const counters = head.data().counters;
    /* The rules keep a head's counters self-consistent, so a head that
       does not add up is not something we should show a shopkeeper as a
       day's takings. Fall through and fold the rows instead. */
    if (isCounterSetValid(counters)) {
      const summary = summaryFromCounters(dateKey, counters);
      summary.expensesPaise = expensesPaise;
      summary.netPaise = summary.paidPaise - expensesPaise;
      return summary;
    }
    console.warn("[trustx-ledger] day head counters failed the consistency check, folding rows instead:", counters);
  }

  if (head && !head.exists()) {
    /* The head really is absent, which means no sale has ever been
       recorded on this day. A missing day is a zero day, not an error,
       and there is nothing to fold. */
    const summary = emptySummary();
    summary.dateKey = dateKey;
    summary.expensesPaise = expensesPaise;
    summary.netPaise = -expensesPaise;
    return summary;
  }

  /* Folding the rows is a genuine fallback here, but it is the expensive
     path by definition, so it must not run when the reason we could not
     read the head is that the day's read budget is already spent. */
  const rows = await fetchTransactions({ dateKey, limit: MAX_DAY_LIMIT });
  return summaryFromRows(rows, expensesPaise);
}

/**
 * Make sure the day has a head before the day's first sale is written.
 *
 * This is why the head is not created inside the batch below: a
 * Firestore batch cannot both create a document and let another
 * document's rules read that document's pre-write state, so a sale
 * filed under a not-yet-existing head could not have its counter delta
 * verified at all.
 *
 * Idempotent and race-tolerant. On a day that already has a head this
 * is a single cached read and no write at all; on a day's first sale it
 * creates the head, and if another device on the counter created it a
 * moment earlier the denial is simply "already there" and we carry on.
 */
async function ensureDayHead(dateKey, fs, db, uid_) {
  const ref = headRef(fs, db, dateKey);
  const snap = await chargedGetDoc(fs, ref);
  if (snap.exists()) return;

  try {
    await guardQuota(() =>
      fs.setDoc(ref, {
        dateKey,
        state: DAY_STATE.OPEN,
        openedAt: fs.serverTimestamp(),
        openedBy: uid_,
        counters: emptyCounters(),
        updatedAt: fs.serverTimestamp(),
        updatedBy: uid_,
      })
    );
    noteWrites();
  } catch (err) {
    /* The create rule only allows the write while the head is absent,
       so a denial means another device got there first. */
    if (!err || err.code !== "permission-denied") throw err;
  }
}

/**
 * Drop every cached read that a sale, edit or delete just made untrue.
 *
 * Invalidated by prefix rather than by listing keys: the cache keys embed
 * page sizes that the callers choose (a day page is 100 rows, the
 * transactions list asks for 200, the history walk for up to 1000, the
 * console asks for 300), so an enumerated list would have to be edited
 * every time a page size changed and would silently leave a stale entry
 * behind the first time somebody forgot — which reads as "the total does not
 * move after I added a sale".
 */
function invalidateDayReads(dateKey) {
  if (!dateKey) {
    headCache.drop();
    rowsCache.drop();
    historyCache.drop();
    monthCache.drop();
    return;
  }
  headCache.dropPrefix(`head:${dateKey}`);
  rowsCache.dropPrefix(`day:${dateKey}:`);
  historyCache.dropPrefix(`txns:${dateKey}:`);
  /* The all-time walk holds rows from every day, including this one. */
  historyCache.dropPrefix("txns:all:");
  /* A month is one read keyed by the month, so a sale filed against a
     past day would otherwise leave the calendar showing the day as
     still missing until its cache window expired. */
  monthCache.drop();
}

/**
 * Read transactions for the all-data browser. With a `dateKey`, reads
 * that day's subcollection; without one, the history page is served by
 * walking the day heads newest-first and reading the days it needs.
 *
 * The all-time read is deliberately NOT one collection-group query.
 * A `transactions` group query spans every `transactions` collection in
 * the database, including the root-level path, and that path lands on
 * the catch-all `allow read, write: if false` in `firestore.rules`.
 * Firestore refuses a query it cannot prove safe, so the whole history
 * page failed with permission-denied no matter how trusted the user
 * was. Day-by-day reads are single-collection, which the rules allow,
 * and they need no composite index either.
 */

/** Days walked by one all-time read. The walk stops early as soon as it
 *  has `limit` rows, so this only bites on a shop that is both older
 *  than this and quieter than `limit` sales inside it; the history page
 *  says so in its footer rather than passing the list off as "all time". */
const HISTORY_DAY_CAP = 120;

export async function fetchTransactions({ dateKey = null, limit = 200 } = {}) {
  const b = await bridge();
  const fs = b.firestore;

  /* This is the most expensive read in the app by a wide margin: the
     all-time walk costs one query per day head it opens, and firestore.rules
     bills a grant lookup against every one of them. Re-reading the same
     history on every visit is the fastest way to spend the Spark plan's
     50,000 reads a day, so the result is cached and refreshed behind the
     scenes — and, because this cache persists, it survives a page load. */
  return historyCache.read(`txns:${dateKey || "all"}:${limit}`, async () => {
    /* Order by documentId as the tiebreak, not just by createdAt.
       Firestore appends __name__ ASCENDING to any orderBy it is not given
       explicitly, so stating it DESCENDING here is what keeps the cursor
       pagination in fetchDayPage and this list from swapping rows as the
       page changes. */
    const newestFirst = [
      fs.orderBy("createdAt", "desc"),
      fs.orderBy(fs.documentId(), "desc"),
    ];

    if (dateKey) {
      const snap = await chargedGetDocs(
        fs,
        fs.query(dayTxnsRef(fs, b.db, dateKey), ...newestFirst, fs.limit(limit))
      );
      return snap.docs.map((d) => normalizeTxn(d.id, d.data(), dateKey));
    }

    /* The rules make every day head carry `dateKey` equal to its own
       document id (see validHeadCreate), so ordering by that field reaches
       the newest days with no head silently left out of the walk. */
    const heads = await chargedGetDocs(
      fs,
      fs.query(fs.collection(b.db, "dayHeads"), fs.orderBy("dateKey", "desc"), fs.limit(HISTORY_DAY_CAP + 1))
    );
    /* One more than the cap is asked for so a truncated walk is detectable
       rather than silent; the page turns this into a footer note. */
    const dayCapped = heads.docs.length > HISTORY_DAY_CAP;

    const rows = [];
    for (const head of heads.docs.slice(0, HISTORY_DAY_CAP)) {
      if (rows.length >= limit) break;
      /* Days are visited newest first and each day is read newest first,
         so concatenating them is already the global order the page wants. */
      const snap = await chargedGetDocs(
        fs,
        fs.query(dayTxnsRef(fs, b.db, head.id), ...newestFirst, fs.limit(limit - rows.length))
      );
      for (const doc of snap.docs) rows.push(normalizeTxn(doc.id, doc.data(), head.id));
    }
    rows.dayCapped = dayCapped;
    rows.dayCap = HISTORY_DAY_CAP;
    return rows;
  });
}

/* ------------------------------------------------------------------
   Daily ledger (single business day)

   Every read below is anchored to one `dateKey`, which is now a PATH
   rather than a filter, so a day view costs no composite index and one
   large day cannot affect another. Cursor pagination is prepared from
   the start: the query asks for one row more than the caller wants,
   uses that extra row to decide whether a further page exists, and
   hands the caller an opaque cursor to resume from.
   ------------------------------------------------------------------ */

/** Upper bound on one day query, mirroring the rules' field ranges. */
const MAX_DAY_LIMIT = 1000;

/**
 * Fetch one page of a single business day, newest first.
 *
 * The first page is cache-first — it is what every page load of the ledger
 * asks for, and re-reading a hundred rows to redraw a screen the shop is
 * already looking at is the read budget going nowhere. Later pages are
 * keyed on the caller's cursor and always read fresh, because they are
 * walked past rarely and a cursor is not a stable cache key.
 *
 * @param {object} opts
 * @param {string} opts.dateKey      Asia/Kolkata `YYYY-MM-DD`.
 * @param {number} [opts.pageSize]   Rows to return (1..1000).
 * @param {*}      [opts.cursor]     Opaque cursor from a previous page.
 * @returns {Promise<{rows: object[], cursor: object|null, hasMore: boolean}>}
 */
export async function fetchDayPage({ dateKey, pageSize = 100, cursor = null } = {}) {
  if (!isValidDateKey(dateKey)) {
    throw new Error("Pick a valid date to view the ledger.");
  }

  const size = Math.min(Math.max(1, Math.trunc(Number(pageSize) || 100)), MAX_DAY_LIMIT);
  const b = await bridge();
  const fs = b.firestore;

  const parts = [
    fs.orderBy("createdAt", "desc"),
    fs.orderBy(fs.documentId(), "desc"),
  ];
  if (cursor) parts.push(fs.startAfter(cursor));
  // One extra row tells us whether a further page exists without a
  // second count query.
  parts.push(fs.limit(size + 1));

  const loadPage = async () => {
    const snap = await chargedGetDocs(fs, fs.query(dayTxnsRef(fs, b.db, dateKey), ...parts));
    const docs = snap.docs;

    if (docs.length <= size) {
      return { rows: docs.map((d) => normalizeTxn(d.id, d.data(), dateKey)), cursor: null, hasMore: false };
    }

    const page = docs.slice(0, size);
    return {
      rows: page.map((d) => normalizeTxn(d.id, d.data(), dateKey)),
      cursor: page[page.length - 1],
      hasMore: true,
    };
  };

  if (cursor) return loadPage();
  return rowsCache.read(`day:${dateKey}:${size}`, loadPage);
}

/**
 * Total number of sales recorded on a day.
 *
 * This is the day head's own `txnCount`, so it is one cached document
 * read rather than a server-side count aggregate — which means the ledger
 * footer can show the true transaction count while only a page of rows is
 * loaded, and still show it offline. The rules keep the counter and the
 * rows in step, so the two cannot disagree.
 *
 * If the head is unreadable the count is genuinely unknown, and the caller
 * is expected to leave it out rather than substitute a number. In
 * particular this throws rather than answering 0 when the day's read quota
 * is spent: a zero would be shown as "this day sold nothing", which is a
 * different and very confident claim.
 */
export async function countDayTransactions(dateKey) {
  if (!isValidDateKey(dateKey)) return 0;
  const b = await bridge();
  const fs = b.firestore;
  const snap = await headCache.read(`head:${dateKey}`, () =>
    chargedGetDoc(fs, headRef(fs, b.db, dateKey))
  );
  /* No head at all means no sale was ever recorded on this day. */
  if (!snap.exists()) return 0;
  const counters = snap.data().counters;
  if (isCounterSetValid(counters)) return toSafe(counters.txnCount);
  /* A head we cannot trust is the one case worth paying for a real count
     rather than showing a shopkeeper a wrong total. */
  console.warn("[trustx-ledger] day head counters unusable, counting the day directly:", counters);
  /* But not when the day's read budget is already spent: a count aggregate
     is billed per thousand index entries scanned, so this is the most
     expensive call in the file and the least likely to be affordable. */
  try {
    const counted = await guardQuota(() =>
      fs.getCountFromServer(dayTxnsRef(fs, b.db, dateKey))
    );
    /* An aggregate is billed per index entry scanned with a floor of one
       read per query, so one is the honest minimum to charge it. */
    noteReads(readsForQuery(1));
    return toSafe(counted.data().count);
  } catch (err) {
    /* Deliberately rethrown rather than answered with 0. A spent quota is
       not "this day sold nothing", and a zero here would be rendered as a
       confident day count of none. The caller already treats a thrown count
       as "unknown" and leaves it out — which is the truth. */
    throw err;
  }
}

/**
 * Whether a business day has been closed. A day is open while its head
 * says so; a head that does not exist yet is open too, because it means
 * no sale has ever been recorded.
 *
 * This read fails *open* on purpose. `getDoc` on a document that was
 * never fetched rejects while the client is offline, and the ledger
 * must stay readable offline — so a failed read reports "open" rather
 * than taking the page down. That cannot let a stale write through: the
 * rules re-check the head's state on the server and refuse the write.
 *
 * That refusal is why this is read at all. Firestore reports a denied
 * write only as "permission-denied", never naming the clause, so a
 * client that never asks cannot tell a closed day from a missing grant
 * — both arrive as the same opaque error. The sale form calls this
 * immediately before writing (see js/sale-form.js onSave) to turn the
 * one case the shop can actually fix into a sentence that says so.
 */
export async function fetchDayState(dateKey) {
  if (!isValidDateKey(dateKey)) return { dateKey, closed: false };
  try {
    const b = await bridge();
    const fs = b.firestore;
    /* Never cached: this read exists so a write can tell a closed day from
       a missing grant, and answering that from a cached head would defeat
       the reason it is made immediately before the write. */
    const snap = await chargedGetDoc(fs, headRef(fs, b.db, dateKey));
    return { dateKey, closed: snap.exists() ? snap.data().state === DAY_STATE.CLOSED : false };
  } catch (err) {
    /* Fail open, as documented, so a bad connection cannot stop the shop
       recording a sale. A spent quota is reported though — the write that
       follows is about to be refused, and the banner should already be up
       before the shopkeeper meets that refusal in a dialog. */
    if (isQuotaExhausted(err)) {
      console.error("[trustx-ledger] day state unavailable, daily quota exhausted:", err);
    } else {
      console.warn("[trustx-ledger] day state unavailable, treating as open:", err);
    }
    return { dateKey, closed: false };
  }
}

/* ------------------------------------------------------------------
   Month calendar (many business days at once)

   The shop fills its ledger in the evening, so the calendar is how it
   finds out which days of the month are still missing. One ranged query
   over the day heads answers the whole month: no per-day reads, no
   composite index (a single `dateKey` order is automatic), and a hard
   ceiling of 31 documents behind the rules' own grant lookups.
   ------------------------------------------------------------------ */

/**
 * Every day head in one month, keyed by `dateKey`.
 *
 * Reads the HEADS, not the sales: a head already carries the day's sale
 * count and money totals, which is all a calendar cell draws, so this
 * stays a month-sized read no matter how busy each day was. A day with
 * no head is absent from the map, which is the honest reading — nothing
 * was ever recorded on it — and js/calendar.js draws that as an empty
 * day rather than a zero-sales day.
 *
 * @param {object} opts
 * @param {string} [opts.yearMonth]  `YYYY-MM`; defaults to this month in India
 * @returns {Promise<object>} dateKey -> { dateKey, state, counters },
 *   carrying `yearMonth` / `monthStart` / `monthEnd` as properties
 */
export async function fetchMonthHeads({ yearMonth = "" } = {}) {
  const bounds = monthBounds(String(yearMonth || "").trim() || currentYearMonth());
  if (!bounds) throw new Error("Pick a valid month to view.");

  const b = await bridge();
  const fs = b.firestore;

  return monthCache.read(`month:${bounds.yearMonth}`, async () => {
    /* The rules pin every head's `dateKey` to its own document id, so
       ordering by that field is the same range as ordering by the id —
       and a head written by an older build with a mismatched field can
       never fall outside the month it belongs to. */
    const snap = await chargedGetDocs(
      fs,
      fs.query(
        fs.collection(b.db, "dayHeads"),
        fs.orderBy("dateKey"),
        fs.startAt(bounds.firstKey),
        fs.endAt(bounds.lastKey)
      )
    );

    const heads = {};
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const dateKey = isValidDateKey(data.dateKey) ? data.dateKey : doc.id;
      /* Out-of-month or unreadable keys are skipped rather than shown:
         a cell is either a day of the month being asked for or it is
         not drawn at all. */
      if (!isValidDateKey(dateKey)) continue;
      if (dateKey < bounds.firstKey || dateKey > bounds.lastKey) continue;
      heads[dateKey] = { dateKey, state: data.state, counters: data.counters };
    }
    heads.yearMonth = bounds.yearMonth;
    heads.monthStart = bounds.firstKey;
    heads.monthEnd = bounds.lastKey;
    return heads;
  });
}

/* ------------------------------------------------------------------
   Writes
   ------------------------------------------------------------------ */

/**
 * Create a transaction. All money math is validated client-side in
 * integer paise; the same constraints are re-enforced by the rules.
 * `rate` is always RUPEES per unit (user-entered) and is converted to
 * integer paise before writing.
 *
 * The sale and the day's counters go out as one atomic batch, so a sale
 * can never land without the day head following it. The head itself is
 * made sure first (see ensureDayHead) because a Firestore batch cannot
 * both create a document and have another document's rules read its
 * pre-write state.
 *
 * @returns {Promise<{txnId, totalPaise, status, dateKey}>}
 */
export async function createTransaction({
  serviceId,
  serviceName,
  quantity,
  rate,        // rupees per unit (user-entered)
  paymentMethod,
  customerName = "",
  dateKey = todayKolkata(),
  receiptImage = null,   // JPEG data URL from the scanner, or null
}) {
  const b = await bridge();
  const fs = b.firestore;
  const user = b.auth.currentUser;

  const qty = sanitizeQuantity(quantity);
  const ratePaise = rateToPaise(rate);
  const totalPaise = computeTotalPaise(qty, ratePaise);

  if (qty === null) throw new Error("Quantity must be a whole number greater than 0.");
  if (ratePaise === null) throw new Error("Enter a valid rate (₹0 or more).");
  if (totalPaise === null) throw new Error("The total is out of the allowed range.");
  if (!serviceId || !String(serviceName || "").trim()) {
    throw new Error("Choose a service to record the sale against.");
  }
  if (typeof serviceName !== "string" || serviceName.length > 80) {
    throw new Error("Service name is invalid.");
  }
  if (!isPaymentMethod(paymentMethod)) {
    throw new Error("Choose a payment method (cash, UPI, card or due).");
  }
  if (!isValidDateKey(dateKey)) {
    throw new Error("That business day is not valid.");
  }
  if (!user || !user.uid) throw new Error("You need to be signed in to record a sale.");

  /* The photo is checked here so an oversized scan is refused with a
     sentence rather than by the rules' bare "denied", and so the sale never
     lands marked as having a receipt that is not there. */
  const image = receiptImage ? String(receiptImage) : "";
  let imageBytes = 0;
  if (image) {
    if (!image.startsWith(RECEIPT_IMAGE_PREFIX)) {
      throw new Error("That receipt photo is not a JPEG the ledger can store.");
    }
    imageBytes = receiptImageBytes(image);
    if (imageBytes === null || imageBytes > RECEIPT_IMAGE_MAX_BYTES) {
      throw new Error(
        "That receipt photo is too large to keep (" +
        Math.round((imageBytes || 0) / 1024) + " KB). " +
        "Re-scan it closer, or save the sale without the photo."
      );
    }
  }

  await ensureDayHead(dateKey, fs, b.db, user.uid);

  const txnId = uid("txn");
  const amounts = splitAmounts(totalPaise, paymentMethod);
  const now = fs.serverTimestamp();

  const doc = {
    txnId,
    serviceId: String(serviceId),
    serviceName: serviceName.trim(),
    quantity: qty,
    rate: ratePaise,
    total: totalPaise,
    amounts,
    paymentMethod,
    customerId: "",
    customerName: String(customerName || "").trim().slice(0, 120),
    status: statusForMethod(paymentMethod),
    dateKey,
    createdAt: now,
    updatedAt: now,
    createdBy: user.uid,
    updatedBy: user.uid,
    hasReceipt: imageBytes > 0,
  };

  const ref = headRef(fs, b.db, dateKey);
  const batch = fs.writeBatch(b.db);
  batch.set(txnRef(fs, b.db, dateKey, txnId), doc);
  batch.update(ref, {
    "counters.txnCount": fs.increment(1),
    "counters.grossPaise": fs.increment(amounts.gross),
    "counters.cashPaise": fs.increment(amounts.cash),
    "counters.upiPaise": fs.increment(amounts.upi),
    "counters.cardPaise": fs.increment(amounts.card),
    "counters.duePaise": fs.increment(amounts.due),
    "counters.collectedPaise": fs.increment(amounts.collected),
    updatedAt: now,
    updatedBy: user.uid,
  });
  /* The photo rides in the SAME batch as the sale, so a sale can never claim
     a receipt that did not land, and the photo can never outlive its sale.

     The ORDER inside the batch is not incidental: the rules let a photo exist
     only for a sale that exists, judged with `existsAfter`, and a document is
     visible to `existsAfter` only to the writes that come after it. So the
     sale has to be written before its photograph — which is why this comes
     after `batch.set` above and not before it. */
  if (imageBytes > 0) {
    batch.set(receiptImageRef(fs, b.db, dateKey, txnId), {
      txnId,
      image,
      bytes: imageBytes,
      capturedAt: now,
      createdBy: user.uid,
    });
  }
  await guardQuota(() => batch.commit());
  /* Two documents go out in this batch - the sale and the day head - or
     three, when a receipt photo is attached. */
  noteWrites(imageBytes > 0 ? 3 : 2);
  invalidateDayReads(dateKey);

  /* `dateKey` is echoed back so a page that is parked on another day can
     follow the sale to the day it landed on. */
  return { txnId, totalPaise, status: doc.status, dateKey, hasReceipt: imageBytes > 0 };
}

/**
 * Create a service on the fly for quick entry. Safe integer paise.
 *
 * `code` and `sortOrder` are optional: quick entry leaves them at their
 * neutral defaults, while the catalog seed passes the two-letter tile
 * code and the group ordering band.
 *
 * `serviceId` is optional for the same reason — a hand-added service
 * gets a random id, while a seeded one gets the deterministic id from
 * the catalog so two devices cannot both create it.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string|number} opts.price  rupees (stored as integer paise)
 * @param {string} [opts.code]        short tile code, <= 12 characters
 * @param {number} [opts.sortOrder]   ordering band
 * @param {string} [opts.serviceId]   explicit document id
 * @returns {Promise<{serviceId, name, pricePaise}>}
 */
export async function createService({ name, price, code = "", sortOrder = 0, serviceId } = {}) {
  const b = await bridge();
  const fs = b.firestore;
  const cleanName = String(name || "").trim();
  const pricePaise = rateToPaise(price);
  if (!cleanName || cleanName.length > 80) {
    throw new Error("Service name must be 1–80 characters.");
  }
  if (pricePaise === null) {
    throw new Error("Enter a valid rate for the service.");
  }
  const cleanCode = String(code == null ? "" : code).trim();
  if (cleanCode.length > 12) {
    throw new Error("Service code must be 12 characters or fewer.");
  }
  /* An id becomes a Firestore document path, so a slash would silently
     write somewhere else entirely. */
  const explicitId = String(serviceId == null ? "" : serviceId).trim();
  if (explicitId.length > 120 || explicitId.includes("/")) {
    throw new Error("That service id is not valid.");
  }
  const user = b.auth.currentUser;
  if (!user || !user.uid) throw new Error("You need to be signed in to add a service.");
  const id = explicitId || uid("svc");
  const doc = {
    serviceId: id,
    name: cleanName,
    code: cleanCode,
    pricePaise,
    active: true,
    sortOrder: toSafe(sortOrder),
    createdAt: fs.serverTimestamp(),
    createdBy: user.uid,
    updatedAt: fs.serverTimestamp(),
    updatedBy: user.uid,
  };
  await guardQuota(() => fs.setDoc(fs.doc(b.db, "services", id), doc));
  noteWrites();
  catalogCache.drop();
  return { serviceId: id, name: cleanName, pricePaise };
}

/**
 * Write the default catalog entries (js/service-catalog.js) the shop does
 * not have yet. Safe to re-run and safe to run on several devices at
 * once: entries are matched by name OR by their deterministic seed id,
 * and a write that loses the race is counted as "already there" rather
 * than treated as a failure.
 *
 * Writes run one at a time on purpose — this runs on a shop counter
 * connection, and a sequential burst is easier to reason about when the
 * network drops half way. A failure part-way leaves the earlier services
 * written, and the next run picks up exactly the rest.
 *
 * @param {object} [opts]
 * @param {Function} [opts.onProgress] called as ({done, total}) per write
 * @returns {Promise<{created: object[], skipped: number, denied: number}>}
 */
export async function seedDefaultServices({ onProgress } = {}) {
  /* `force`: which entries are missing is decided by what is actually in
     the database, not by what this tab last saw. */
  const existing = await fetchServices({ includeInactive: true, force: true });
  const missing = findMissingCatalogServices(existing);
  if (!missing.length) return { created: [], skipped: existing.length, denied: 0 };

  const created = [];
  let denied = 0;
  for (const entry of missing) {
    try {
      created.push(
        await createService({
          serviceId: entry.seedId,
          name: entry.name,
          price: entry.price,
          code: entry.code,
          sortOrder: entry.sortOrder,
        })
      );
    } catch (err) {
      /* Another device created this exact document first. The rules
         refuse the overwrite (an update must keep createdAt/createdBy),
         so a denial here means "already seeded", not a failure. */
      if (err && (err.code === "PERMISSION_DENIED" || err.code === "permission-denied")) denied += 1;
      else throw err;
    }
    if (typeof onProgress === "function") {
      onProgress({ done: created.length + denied, total: missing.length });
    }
  }
  return { created, skipped: existing.length, denied };
}

/**
 * Make sure the shop has the default catalog. Called by the
 * protected-page shell before the first render, so a fresh shop finds the
 * services already on its dashboard instead of an empty grid.
 *
 * Best effort by design: this is convenience, not ledger data, so a
 * failure is logged and swallowed rather than taking the page down — the
 * Developer console can still seed by hand.
 *
 * @returns {Promise<{created: number, skipped: boolean, denied: number}>}
 */
export async function ensureCatalogSeeded() {
  try {
    const { created, denied } = await seedDefaultServices();
    if (created.length || denied) {
      console.info(
        `[trustx-ledger] default services seeded: ${created.length} added` +
        (denied ? `, ${denied} already present` : "")
      );
    }
    return { created: created.length, skipped: false, denied };
  } catch (err) {
    console.warn("[trustx-ledger] default services could not be seeded:", err);
    return { created: 0, skipped: true, denied: 0 };
  }
}

/**
 * Edit a service (Developer only — the rules enforce it). Pass only the
 * fields you want to change: `name`, `price` (rupees), `active`.
 */
export async function updateService(serviceId, { name, price, active } = {}) {
  const b = await bridge();
  const fs = b.firestore;
  if (!serviceId) throw new Error("Missing service id.");
  const user = b.auth.currentUser;
  if (!user || !user.uid) throw new Error("You need to be signed in to update a service.");

  const patch = {};
  if (name !== undefined) {
    const clean = String(name).trim();
    if (!clean || clean.length > 80) throw new Error("Service name must be 1–80 characters.");
    patch.name = clean;
  }
  if (price !== undefined) {
    const pricePaise = rateToPaise(price);
    if (pricePaise === null) throw new Error("Enter a valid rate for the service.");
    patch.pricePaise = pricePaise;
  }
  if (active !== undefined) patch.active = active === true;
  if (!Object.keys(patch).length) return { serviceId };

  patch.updatedAt = fs.serverTimestamp();
  patch.updatedBy = user.uid;
  await guardQuota(() => fs.updateDoc(fs.doc(b.db, "services", serviceId), patch));
  noteWrites();
  catalogCache.drop();
  return { serviceId, ...patch };
}

/**
 * Edit a recorded sale.
 *
 * The editable surface mirrors what the rules will accept. `txnId`,
 * `createdAt`, `createdBy`, `customerId` and `dateKey` stay pinned to
 * the original row, so a sale can never be re-dated onto another
 * business day (which is also what keeps the day-close gate sound).
 *
 * The service is chosen from the catalog rather than typed. The catalog
 * lives in the Realtime Database now and Firestore rules cannot read
 * across, so the name is snapshotted into the sale and the rules only
 * prove it is a sane string — which is why this function re-reads the
 * service and refuses an archived one, rather than trusting the caller.
 *
 * `total` is always recomputed from quantity x rate rather than trusted
 * from the caller, and `updatedAt` / `updatedBy` are always refreshed.
 * Changing the payment method moves money between the day's buckets, so
 * the head is shifted in the same batch.
 *
 * @param {string} txnId
 * @param {string} dateKey  the day the sale is filed under
 * @param {object} patch
 */
export async function updateTransaction(txnId, dateKey, patch = {}) {
  const id = String(txnId || "").trim();
  if (!id) throw new Error("That sale could not be found.");
  if (!isValidDateKey(dateKey)) throw new Error("That business day is not valid.");

  const b = await bridge();
  const fs = b.firestore;
  const user = b.auth.currentUser;
  if (!user || !user.uid) throw new Error("You need to be signed in to edit a sale.");

  const ref = txnRef(fs, b.db, dateKey, id);
  const before = await chargedGetDoc(fs, ref);
  if (!before.exists()) throw new Error("That sale could not be found.");
  const prev = before.data();

  const qty = sanitizeQuantity(patch.quantity);
  if (qty === null) throw new Error("Quantity must be a whole number greater than 0.");

  // `rate` is stored in paise, so validate it as an integer directly
  // instead of round-tripping through rupees.
  const ratePaise = toPaiseInt(patch.ratePaise);
  if (patch.ratePaise == null || patch.ratePaise === "" || ratePaise < 0) {
    throw new Error("Enter a valid rate (₹0 or more).");
  }

  const totalPaise = computeTotalPaise(qty, ratePaise);
  if (totalPaise === null) throw new Error("The total is out of the allowed range.");

  const serviceId = String(patch.serviceId || "").trim();
  if (!serviceId) throw new Error("Choose a service for this sale.");

  let serviceName = String(patch.serviceName || "").trim();
  const svcSnap = await chargedGetDoc(fs, fs.doc(b.db, "services", serviceId));
  if (!svcSnap.exists()) throw new Error("That service no longer exists.");
  const serviceDoc = svcSnap.data();
  if (serviceDoc.active !== true) throw new Error("That service is archived and cannot be used.");
  serviceName = String(serviceDoc.name || "").trim();
  if (!serviceName) throw new Error("That service has no name.");

  if (!isPaymentMethod(patch.paymentMethod)) {
    throw new Error("Choose a payment method (cash, UPI, card or due).");
  }

  const method = patch.paymentMethod;
  let status = patch.status === "paid" || patch.status === "pending" ? patch.status : null;
  if (!status) status = statusForMethod(method);
  // A non-due sale is always settled; only a due sale may sit pending.
  if (method !== "due") status = "paid";

  const amounts = splitAmounts(totalPaise, method);
  /* The day's counters move by the DIFFERENCE, so the row's previous
     contribution has to come back off. Read from the stored split, and
     fall back to re-splitting the row for a document written before the
     split existed. */
  /* No fallback argument: same reason as deleteTransaction. */
  const prevAmounts = amountsFromDoc(prev);

  const now = fs.serverTimestamp();
  const next = {
    serviceId,
    serviceName,
    quantity: qty,
    rate: ratePaise,
    total: totalPaise,
    amounts,
    paymentMethod: method,
    status,
    customerName: String(patch.customerName || "").trim().slice(0, 120),
    updatedAt: now,
    updatedBy: user.uid,
  };

  const head = headRef(fs, b.db, dateKey);
  const batch = fs.writeBatch(b.db);
  batch.update(ref, next);
  batch.update(head, {
    "counters.txnCount": fs.increment(0),
    "counters.grossPaise": fs.increment(amounts.gross - prevAmounts.gross),
    "counters.cashPaise": fs.increment(amounts.cash - prevAmounts.cash),
    "counters.upiPaise": fs.increment(amounts.upi - prevAmounts.upi),
    "counters.cardPaise": fs.increment(amounts.card - prevAmounts.card),
    "counters.duePaise": fs.increment(amounts.due - prevAmounts.due),
    "counters.collectedPaise": fs.increment(amounts.collected - prevAmounts.collected),
    updatedAt: now,
    updatedBy: user.uid,
  });
  await guardQuota(() => batch.commit());
  noteWrites(2);
  invalidateDayReads(dateKey);

  return { txnId: id, totalPaise, status };
}

/**
 * Settle a due sale. Flips `status` to `paid` and refreshes the audit
 * fields; nothing else on the row is touched. Settling does not move any
 * money — it was always owed and always counted as due — so the day's
 * counters are deliberately left alone.
 */
export async function markTransactionPaid(txnId, dateKey) {
  const id = String(txnId || "").trim();
  if (!id) throw new Error("That sale could not be found.");
  if (!isValidDateKey(dateKey)) throw new Error("That business day is not valid.");

  const b = await bridge();
  const fs = b.firestore;
  const user = b.auth.currentUser;
  if (!user || !user.uid) throw new Error("You need to be signed in to settle a due sale.");

  await guardQuota(() =>
    fs.updateDoc(txnRef(fs, b.db, dateKey, id), {
      status: "paid",
      updatedAt: fs.serverTimestamp(),
      updatedBy: user.uid,
    })
  );
  noteWrites();
  invalidateDayReads(dateKey);
  return { txnId: id, status: "paid" };
}

/**
 * Delete a recorded sale. Callers are expected to confirm with the
 * user first; the rules independently refuse the write on a closed
 * day and for a caller who is not signed in.
 *
 * The day's counters retreat by exactly this sale, in the same batch,
 * so the head can never be left counting a sale that is gone.
 */
export async function deleteTransaction(txnId, dateKey) {
  const id = String(txnId || "").trim();
  if (!id) throw new Error("That sale could not be found.");
  if (!isValidDateKey(dateKey)) throw new Error("That business day is not valid.");

  const b = await bridge();
  const fs = b.firestore;
  const user = b.auth.currentUser;
  if (!user || !user.uid) {
    throw new Error("You need to be signed in to delete a sale.");
  }

  const ref = txnRef(fs, b.db, dateKey, id);
  const snap = await chargedGetDoc(fs, ref);
  if (!snap.exists()) return { txnId: id };
  const d = snap.data();
  /* No fallback argument: the document's own method is what its
     contribution was booked under, and a malformed one degrades to cash
     rather than blocking the delete. */
  const amounts = amountsFromDoc(d);

  const batch = fs.writeBatch(b.db);
  batch.delete(ref);
  /* The photo goes with the sale, in the same batch. Leaving it would keep
     paying for a document nobody can reach: the rules only ever expose a
     photo through its sale's day. */
  if (d.hasReceipt === true) {
    batch.delete(receiptImageRef(fs, b.db, dateKey, id));
  }
  batch.update(headRef(fs, b.db, dateKey), {
    "counters.txnCount": fs.increment(-1),
    "counters.grossPaise": fs.increment(-amounts.gross),
    "counters.cashPaise": fs.increment(-amounts.cash),
    "counters.upiPaise": fs.increment(-amounts.upi),
    "counters.cardPaise": fs.increment(-amounts.card),
    "counters.duePaise": fs.increment(-amounts.due),
    "counters.collectedPaise": fs.increment(-amounts.collected),
    updatedAt: fs.serverTimestamp(),
    updatedBy: user.uid,
  });
  await guardQuota(() => batch.commit());
  /* One delete and one head update: they have separate Spark allowances.
     A sale with a photo deletes two documents. */
  noteWrites();
  noteDeletes(d.hasReceipt === true ? 2 : 1);
  invalidateDayReads(dateKey);
  forgetReceiptImage(dateKey, id);

  return { txnId: id };
}

/* ------------------------------------------------------------------
   Receipt photos, read on demand.
   The day's rows carry only a boolean (`hasReceipt`), so the photo is
   fetched when someone asks to see it and then kept in memory for the
   rest of the session — opening the same receipt twice costs one read,
   not two.
   ------------------------------------------------------------------ */

const receiptImageCache = new Map();

const receiptCacheKey = (dateKey, txnId) => dateKey + "/" + txnId;

/**
 * The receipt photo for one sale, as a JPEG data URL.
 *
 * @param {string} txnId    the sale
 * @param {string} dateKey  the business day the sale was filed under
 * @returns {Promise<string|null>} null when the sale has no photo on file.
 */
export async function fetchReceiptImage(txnId, dateKey) {
  const id = String(txnId || "").trim();
  if (!id || !isValidDateKey(dateKey)) return null;

  const key = receiptCacheKey(dateKey, id);
  if (receiptImageCache.has(key)) return receiptImageCache.get(key);

  const b = await bridge();
  const snap = await chargedGetDoc(b.firestore, receiptImageRef(b.firestore, b.db, dateKey, id));
  if (!snap.exists()) {
    receiptImageCache.set(key, null);
    return null;
  }
  const data = snap.data();
  const image = typeof data.image === "string" && data.image ? data.image : null;
  receiptImageCache.set(key, image);
  return image;
}

/** Drop a cached photo — after the sale is deleted. */
function forgetReceiptImage(dateKey, txnId) {
  receiptImageCache.delete(receiptCacheKey(dateKey, String(txnId || "").trim()));
}

/**
 * Close a business day: the end-of-evening "lock up the till" step.
 *
 * A closed day is one the ledger has finished with. The rules refuse
 * every sale write against it (`dayOpen`), so this is what turns "the
 * shopkeeper has gone home" into something the data actually enforces
 * rather than a promise in someone's head.
 *
 * Counters are deliberately NOT touched: firestore.rules compares them
 * to the pre-write state and allows a close only when they are
 * unchanged, so closing can never quietly move a day's totals. Only the
 * state and the closing stamp go out.
 *
 * Closing a day that has no head is refused rather than creating an
 * empty one — a day with nothing on it was never opened, and a head
 * whose counters are all zero would be indistinguishable on the
 * calendar from a real day that sold nothing.
 *
 * @param {string} dateKey
 * @returns {Promise<{dateKey: string, closed: boolean}>}
 */
export async function closeDay(dateKey) {
  return setDayState(dateKey, DAY_STATE.CLOSED);
}

/**
 * Re-open a closed day so a correction can be filed against it.
 *
 * The exact mirror of closeDay: same counters, and the closing stamp is
 * DELETED rather than blanked. firestore.rules' `openHeadShape` refuses
 * an open head that still carries closedAt/closedBy, so a stale stamp
 * left behind would make every later write to that day fail.
 *
 * Re-opening is how the ledger stays honest about a mistake: a sale
 * typed against the wrong day, or a rate entered twice, is fixed on the
 * day it belongs to instead of being worked around in the next one.
 *
 * @param {string} dateKey
 * @returns {Promise<{dateKey: string, closed: boolean}>}
 */
export async function reopenDay(dateKey) {
  return setDayState(dateKey, DAY_STATE.OPEN);
}

/**
 * Move a day between open and closed. Shared by closeDay/reopenDay so
 * the two cannot drift apart on anything that matters.
 *
 * The head is re-read fresh (never through the cache) immediately before
 * the write, because the answer to "is this day already closed?" decides
 * what gets written and a cached head would write the wrong one.
 */
async function setDayState(dateKey, state) {
  if (!isValidDateKey(dateKey)) throw new Error("That business day is not valid.");

  const b = await bridge();
  const fs = b.firestore;
  const user = b.auth.currentUser;
  if (!user || !user.uid) throw new Error("You need to be signed in to change a business day.");

  const closing = state === DAY_STATE.CLOSED;
  const ref = headRef(fs, b.db, dateKey);

  /* Never cached: this read decides what the write says. */
  const snap = await chargedGetDoc(fs, ref);
  if (!snap.exists()) {
    throw new Error(
      closing
        ? "There is nothing recorded on this day yet, so there is no day to close."
        : "This day was never closed — there is nothing recorded on it."
    );
  }
  if (snap.data().state === state) {
    return { dateKey, closed: closing };
  }

  const now = fs.serverTimestamp();
  const change = { state, updatedAt: now, updatedBy: user.uid };
  if (closing) {
    change.closedAt = now;
    change.closedBy = user.uid;
  } else {
    /* Removed, not emptied: an empty string would still be a field, and
       the rules' openHeadShape rejects any field it does not name. */
    change.closedAt = fs.deleteField();
    change.closedBy = fs.deleteField();
  }

  await guardQuota(() => fs.updateDoc(ref, change));
  noteWrites();
  invalidateDayReads(dateKey);

  return { dateKey, closed: closing };
}

/**
 * Resolve once all locally queued writes have hit the server. Rejects
 * when the client is offline (nothing to wait on in that case).
 * Used for the "Changes synced" feedback after working offline.
 *
 * Firestore only, and that is enough: the Realtime Database SDK resolves
 * a set/update promise once the write has been acked by the server, so
 * by the time an expense or catalog write returns there is nothing left
 * queued on that side to wait for.
 */
export async function flushPendingWrites() {
  const b = await bridge();
  const fs = b.firestore;
  await fs.waitForPendingWrites(b.db);
  return true;
}

/**
 * Coarse check: did this error come from being offline / no network?
 *
 * Recognises both databases. Firestore reports `unavailable` and
 * `deadline-exceeded`; the Realtime Database reports its own
 * `network-error` and `disconnected` codes and a WebSocket-flavoured
 * message, and a shop on a patchy connection can get either.
 */
export function isNetworkError(err) {
  const code = err && err.code ? String(err.code) : "";
  if (
    code === "unavailable" ||
    code === "network-error" ||
    code === "disconnected" ||
    /network|internet|offline|fetch|deadline-exceeded/i.test(code)
  ) {
    return true;
  }
  const msg = err && err.message ? String(err.message) : "";
  return /Failed to fetch|NetworkError|load failed|network error|offline|client is disconnected|connection (closed|failed|error)|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|WebSocket/i.test(
    msg
  );
}
