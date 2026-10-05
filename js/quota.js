/* =========================================================
   TrustX Ledger — Firebase Spark (free plan) survival kit
   -----------------------------------------------------------------
   The shop runs on the Spark plan on purpose: no billing account, no
   card, no surprise invoice. That comes with three consequences this
   module exists to handle.

   1. HARD DAILY WALLS, NO WARNING.
      Cloud Firestore on Spark allows 50,000 document reads, 20,000 writes
      and 20,000 deletes per day. The moment any one of them is crossed
      every subsequent operation fails with RESOURCE_EXHAUSTED until the
      daily reset — there is no partial service and no back-pressure. The
      day rolls over around midnight Pacific, which is roughly 12:30–1:30pm
      in India: mid-afternoon on a working day.

   2. NO BUDGET ALERTS EXIST ON SPARK.
      Budgets, spend caps and billing alerts are Cloud Billing features,
      and a Spark project has no billing account to attach them to. The
      console Usage tab is a REPORTER, not an alerter, and it under-counts
      on purpose: zero-result queries and index-entry reads are billed but
      never appear in it. So the only early warning available is one we
      measure ourselves — hence the meter in the second half of this file.

   3. A REJECTED WRITE IS NOT QUEUED.
      Offline persistence holds a write while the client is offline. It
      does NOT hold a write the server refused, which is exactly what a
      quota rejection is. A sale that hits the wall is gone, so the caller
      has to say so loudly rather than treat it as a retryable hiccup —
      see js/sale-form.js.

   The meter below is an ESTIMATE for this browser, not an accountant. It
   exists to turn a hard wall into an early, actionable warning; the
   Firebase console's Usage tab remains the ground truth. Nothing renders
   the counters — they are counted so the "quota is gone" notice can be
   raised the moment a wall is actually hit, and so the wall's size is a
   named constant rather than a number spread through the code.
   ========================================================= */

/* ---------- The walls themselves ---------- */

/** Cloud Firestore daily no-cost limits. Spark only — Blaze has no cap. */
export const SPARK_LIMITS = Object.freeze({
  readsPerDay: 50000,
  writesPerDay: 20000,
  deletesPerDay: 20000,
});

/* ---------- Recognising the wall ---------- */

/**
 * True when an error is Firebase telling us the Spark daily quota is gone.
 *
 * Matching is on `code`, never on message text: the documented message
 * ("This database has exceeded their daily quota or the ramp up limit for
 * writes, please retry with exponential backoff") is not a stable string
 * to parse, and the sibling code `resource-exhausted` is what the JS SDK
 * actually sets. Both databases are covered — Realtime Database uses the
 * same gRPC status for its own plan limits.
 *
 * The message is consulted only as a fallback, and only for words that
 * cannot plausibly appear in an unrelated error.
 *
 * @param {*} err
 * @returns {boolean}
 */
export function isQuotaExhausted(err) {
  if (!err) return false;

  /* Lower-cased, and with gRPC's RESOURCE_EXHAUSTED underscored spelling
     folded onto the one the JS SDK uses — both spellings reach a browser,
     and a wall that fails to match is a sale the shop loses. */
  const code = typeof err.code === "string" ? err.code.toLowerCase().replace(/_/g, "-") : "";
  if (code === "resource-exhausted") return true;
  /* Namespace-suffixed form, e.g. "firestore/resource-exhausted". */
  if (code.endsWith("/resource-exhausted")) return true;

  const msg = String(err.message || "");
  return /quota|exceed(?:ed|s)? (?:the )?(?:daily )?(?:free )?(?:tier )?(?:quota|limit)/i.test(msg);
}

/* ---------- The quota-exhausted notice ---------- */

/**
 * Subscribers told the first time this session hits the wall. The banner
 * is a session-wide event, not a per-error event: a hard wall makes
 * everything fail at once, and a shop does not need the same sentence
 * twenty times.
 *
 * @param {(err: *) => void} cb
 * @returns {() => void} unsubscribe
 */
export function onQuotaExhausted(cb) {
  const listeners = quotaListeners;
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i !== -1) listeners.splice(i, 1);
  };
}

const quotaListeners = [];
let quotaAnnounced = false;

/**
 * Run `fn`, and if it fails because the daily quota is gone, announce it
 * before re-throwing. Used to wrap the money path so every caller gets
 * the classification without repeating the try/catch.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function guardQuota(fn) {
  try {
    return await fn();
  } catch (err) {
    if (isQuotaExhausted(err)) announceQuotaExhausted(err);
    throw err;
  }
}

/** Announce once per page load. Not exported: go through guardQuota. */
function announceQuotaExhausted(err) {
  if (quotaAnnounced) return;
  quotaAnnounced = true;
  console.error(
    "[trustx-ledger] Firestore daily quota exhausted (Spark plan). " +
      "Every read and write will fail until the daily reset. " +
      "Nothing queued by offline persistence will recover this one.",
    err
  );
  for (const cb of quotaListeners.slice()) {
    try {
      cb(err);
    } catch (listenerErr) {
      console.warn("[trustx-ledger] quota listener failed:", listenerErr);
    }
  }
}

/* =========================================================
   Usage meter
   ========================================================= */

const USAGE_KEY = "trustx.usage.v1";

/**
 * Date key for the quota day, in the timezone Firestore actually resets
 * on — America/Los_Angeles — NOT the shop's Asia/Kolkata day.
 *
 * This matters more than it looks. A meter keyed to local time resets
 * seven and a half hours away from the quota it is meant to warn about,
 * so it would read zero for most of the morning and then jump, which is
 * precisely when the shop needs it to be right.
 */
function pacificDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** YYYY-MM-DD one day after `dateKey`. Pure arithmetic, no Date maths. */
function addOneDay(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

/**
 * The next Pacific midnight, as a Date — i.e. when the daily quota resets.
 *
 * Found by bisecting on observed date keys rather than by adding 24 hours,
 * because Pacific is on DST: on the two switchover days a day is 23 or 25
 * hours long and an arithmetic answer would be an hour out.
 */
function nextPacificMidnight(from = new Date()) {
  const target = addOneDay(pacificDayKey(from));
  let lo = from.getTime();
  let hi = lo + 26 * 60 * 60 * 1000; // wider than any real Pacific day
  while (hi - lo > 30 * 1000) {
    const mid = (lo + hi) / 2;
    if (pacificDayKey(new Date(mid)) >= target) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

/**
 * When the quota resets, formatted in the shop's own timezone — "1:30 pm".
 * Uses the shared Kolkata formatter so it matches every other clock in the
 * app. Null when no formatter is reachable (bare Node).
 */
export function quotaResetTime(from = new Date()) {
  const at = nextPacificMidnight(from);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .format(at)
      .toLowerCase();
  } catch {
    return null;
  }
}

/** localStorage, or null. Guarded: this module is imported by the tests. */
function storage() {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    /* Blocked by privacy settings. The meter still works in memory. */
    return null;
  }
}

function blankUsage() {
  return { dayKey: pacificDayKey(), reads: 0, writes: 0, deletes: 0 };
}

/** Read today's counters, rolling over to a fresh day when needed. */
function loadUsage() {
  const empty = blankUsage();
  const store = storage();
  if (!store) return empty;
  try {
    const raw = store.getItem(USAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.dayKey !== empty.dayKey) return empty;
    return {
      dayKey: empty.dayKey,
      reads: Math.max(0, Number(parsed.reads) || 0),
      writes: Math.max(0, Number(parsed.writes) || 0),
      deletes: Math.max(0, Number(parsed.deletes) || 0),
    };
  } catch {
    return empty;
  }
}

let usage = loadUsage();
let persistTimer = null;

/** Persist, coalesced: a page load issues dozens of queries, not dozens of writes. */
function persistUsage() {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const store = storage();
    if (!store) return;
    try {
      store.setItem(USAGE_KEY, JSON.stringify(usage));
    } catch {
      /* Full or blocked. The meter is advisory; losing it is not fatal. */
    }
  }, 1000);
}

function bump(field, n) {
  const count = Math.max(0, Math.trunc(Number(n) || 0));
  if (!count) return;
  /* A browser left open across the Pacific rollover starts the new day
     from zero rather than carrying yesterday's count into it — and the
     "quota is gone" notice clears with it, because the next operation
     really can succeed again. A tab left open through the reset would
     otherwise go on warning about a wall that is no longer there, and the
     shop would stop believing it. */
  rollOverIfNeeded();
  usage[field] += count;
  persistUsage();
}

/**
 * Billable reads for one Firestore query that returned `docCount` docs.
 *
 * Firestore charges a minimum of one read per query even when it returns
 * nothing, and `firestore.rules` gates every collection behind `trusted()`,
 * which itself costs a `get(accessGrants/{uid})`. Those rule lookups are
 * billed as reads too, so a query returning N documents is charged about
 * N+1. Counting the +1 is what keeps the meter honest about the largest
 * cost in the app — the all-time history walk issues hundreds of queries.
 *
 * @param {number} docCount
 * @returns {number}
 */
export function readsForQuery(docCount) {
  const n = Math.max(0, Math.trunc(Number(docCount) || 0));
  return n > 0 ? n + 1 : 1;
}

/** Add `n` reads (default 1). */
export function noteReads(n = 1) {
  bump("reads", n);
}

/** Add `n` writes (default 1). A batched op still counts once per document. */
export function noteWrites(n = 1) {
  bump("writes", n);
}

/** Add `n` deletes (default 1). Deletes have their own Spark allowance. */
export function noteDeletes(n = 1) {
  bump("deletes", n);
}

/**
 * Reset the counters when the Pacific day has turned over.
 *
 * Centralised so every entry point agrees on when "today" changed,
 * including clearing the exhausted notice. Kept in step with
 * `blankUsage()`, which is what the rollover resets to.
 */
function rollOverIfNeeded() {
  if (usage.dayKey === pacificDayKey()) return false;
  usage = blankUsage();
  quotaAnnounced = false;
  return true;
}
