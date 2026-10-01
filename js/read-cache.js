/* =========================================================
   TrustX Ledger — Read-through cache
   -----------------------------------------------------------------
   A Firestore read served entirely from the local cache costs NOTHING,
   while the same read from the server is one of the 50,000 the Spark plan
   allows per day. This module spends that asymmetry deliberately: it
   serves a recent value instead of paying for it again, and refreshes from
   the server in the background so the next read is warm too.

   Two lifetimes, because they answer two different questions:

     freshTtlMs How recent a value must be to be served with no request at
                all. The common case: open the dashboard five times in a
                minute and only the first costs a read.

     staleTtlMs How stale a value may be RETURNED at all. Between the two
                the value is still served, but a single background refresh
                is kicked off behind the page and the next reader gets the
                new value. Past this the caller waits for the server again.

   Serving stale-while-refreshing rather than blocking is the point for
   anything a shopkeeper is waiting on: the day's total appears instantly
   off the last known value and corrects itself a moment later, instead of
   holding a spinner to shave a few hundred milliseconds.

   What this must never be used for: anything a write depends on. A sale
   must re-read its day head from the server, because the whole guarantee
   in firestore.rules rests on the server seeing the real pre-write state,
   and a cached head cannot stand in for that. Callers pass
   `{ force: true }` for those, and there are only three of them.

   A note on WHY this is a JavaScript cache and not the SDK's own
   `source: "cache"`: the local Firestore cache is best-effort. It can hold
   only part of a day's rows, or nothing at all after eviction, and
   `getDocsFromCache` will happily hand back that partial answer. Trusting
   it would mean the history page could silently show fewer sales than the
   shop actually made — a worse failure than spending a few hundred reads,
   and one nobody would notice until a total did not add up. So values are
   cached here instead, in full or not at all, optionally in localStorage so
   the saving survives the page reload that a module-scoped Map would not.
   ========================================================= */

/** Namespace for persisted cache entries, so two apps cannot collide. */
const PREFIX = "trustx.cache.v1:";

/**
 * @param {object} opts
 * @param {number} opts.freshTtlMs   how recent a value must be to be served silently
 * @param {number} opts.staleTtlMs   how stale a value may be served while it refreshes
 * @param {(err: *) => void} [opts.onError] background-refresh failures land here
 * @param {string} [opts.persist]    localStorage namespace, to survive a page reload
 */
export function createReadCache({ freshTtlMs, staleTtlMs, onError = null, persist = null }) {
  /* key -> { value, fetchedAt } */
  const entries = new Map();
  /* key -> the in-flight request, so N callers cause one read. */
  const inflight = new Map();

  /* Bumped by every invalidation. An in-flight read that was issued before
     the bump no longer believes it is allowed to write its result — see
     load(). */
  let epoch = 0;

  /**
   * Bumped on every successful store, so a cache created twice under the
   * same storage namespace (two module instances, say) cannot serve each
   * other's values after one of them has invalidated its half.
   */
  let persistEpoch = 0;

  /* Storage is best effort and may be absent (this module is unit-tested in
     Node) or full or blocked. Every access is guarded; losing the persisted
     copy only costs the cross-reload saving, never correctness. */
  const store = (() => {
    if (!persist) return null;
    try {
      const s = typeof localStorage !== "undefined" ? localStorage : null;
      if (!s) return null;
      const probe = `${PREFIX}${persist}.probe`;
      s.setItem(probe, "1");
      s.removeItem(probe);
      return s;
    } catch {
      return null;
    }
  })();

  const storageKey = (key) => `${PREFIX}${persist}:${key}`;

  function saveToStorage(key, value, fetchedAt) {
    if (!store) return;
    /* Only values that survive a round trip through JSON are persisted —
       chiefly so this can never be switched on for a cache holding
       Firestore snapshots, which would silently persist to "[object
       Object]" and then serve that back as the answer. */
    let serialised;
    try {
      serialised = JSON.stringify(value);
    } catch {
      return;
    }
    if (serialised === undefined) return;
    try {
      store.setItem(storageKey(key), JSON.stringify({ v: persistEpoch, at: fetchedAt, value: serialised }));
    } catch {
      /* Quota exceeded, or storage turned off mid-session. */
    }
  }

  function loadFromStorage(key) {
    if (!store) return null;
    let raw;
    try {
      raw = store.getItem(storageKey(key));
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      /* A write from another instance invalidates this namespace. */
      if (!parsed || parsed.v !== persistEpoch) return null;
      /* Older than the stale window: the saved copy is not an answer. */
      if (Date.now() - parsed.at >= staleTtlMs) return null;
      return { value: JSON.parse(parsed.value), fetchedAt: parsed.at };
    } catch {
      return null;
    }
  }

  function forgetStorage(key) {
    if (!store) return;
    try {
      if (key === undefined) {
        /* Only this namespace's keys — the cache must not clear storage
           that belongs to other parts of the app. */
        const doomed = [];
        for (let i = 0; i < store.length; i += 1) {
          const k = store.key(i);
          if (k && k.startsWith(`${PREFIX}${persist}:`)) doomed.push(k);
        }
        for (const k of doomed) store.removeItem(k);
      } else {
        store.removeItem(storageKey(key));
      }
    } catch {
      /* Nothing to do; the entry is already gone from memory. */
    }
  }

  function remember(key, value, fetchedAt) {
    entries.set(key, { value, fetchedAt });
    saveToStorage(key, value, fetchedAt);
  }

  /**
   * One request per key at a time, shared by every caller that wants it,
   * successful or not. A cache that fires a second read while the first is
   * still open would hand out the same data twice for the price of two —
   * which is the exact waste this module exists to remove.
   */
  function load(key, loader) {
    const existing = inflight.get(key);
    if (existing) return existing;

    const issuedAt = epoch;
    const task = Promise.resolve()
      .then(() => loader())
      .then((value) => {
        /* A sale that landed while this read was open has already
           invalidated everything it touches. Storing this answer anyway
           would resurrect the pre-sale totals for the length of the TTL
           and show a shopkeeper a total that does not include their own
           sale — so an invalidated read is returned to its caller and
           simply not kept. */
        if (epoch === issuedAt) remember(key, value, Date.now());
        return value;
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, task);
    return task;
  }

  /**
   * The cached value if recent enough, otherwise `loader()`.
   * A throw from `loader` propagates and leaves the cache untouched, so a
   * failure is never mistaken for a value.
   *
   * @param {string} key
   * @param {() => Promise<*>} loader
   * @param {object} [opts]
   * @param {boolean} [opts.force] bypass the cache entirely (write paths)
   * @returns {Promise<*>}
   */
  async function read(key, loader, { force = false } = {}) {
    if (force) return load(key, loader);

    let entry = entries.get(key);
    /* Not in memory — but possibly left by the previous page load, which is
       the case this cache exists for: the history walk is the most
       expensive read in the app, and re-buying the whole thing because
       the shopkeeper pressed F5 is the read budget going nowhere. */
    if (!entry && !force) {
      const saved = loadFromStorage(key);
      if (saved) {
        entry = saved;
        entries.set(key, saved);
      }
    }

    const age = entry ? Date.now() - entry.fetchedAt : Infinity;

    /* Fresh: serve it and spend nothing. */
    if (age < freshTtlMs) return entry.value;

    /* Stale but usable: serve it now, re-check behind the page. The
       refresh is deliberately not awaited — the caller is a screen that
       should paint immediately — and it is deduped, so a burst of readers
       causes one refresh. */
    if (age < staleTtlMs) {
      load(key, loader).catch((err) => {
        /* A failed refresh must not take the page down, and must not be
           cached either: the entry keeps its previous fetchedAt, so the
           next read tries again and the value on screen stays the last one
           we genuinely knew. */
        if (onError) onError(err);
      });
      return entry.value;
    }

    /* Too old, or nothing cached: wait for the server. */
    return load(key, loader);
  }

  /** Forget one key, or everything when called with no argument. */
  function drop(key) {
    if (key === undefined) {
      entries.clear();
      forgetStorage();
      /* The whole namespace is now untrustworthy, so anything a second
         cache instance under this name still holds must be ignored. */
      persistEpoch += 1;
    } else {
      entries.delete(key);
      forgetStorage(key);
    }

    /* In-flight requests are not cancelled — there is nothing to cancel
       them with, and letting them finish is harmless — but the bump means
       none of them can write its now-stale answer back into the cache. */
    epoch += 1;
  }

  /**
   * Forget every key starting with `prefix`.
   *
   * A write invalidates a FAMILY of reads — one sale makes the day's head,
   * that day's page, that day's row list and the all-time walk wrong at
   * once — and those keys embed page sizes the caller chooses. Enumerating
   * the exact strings here would mean every new page size silently left a
   * stale entry behind, which is the kind of bug that shows up as a day's
   * total not moving. Matching on the prefix cannot rot that way.
   *
   * The epoch bump covers every key, not just the matching ones. A read of
   * some unrelated key in flight at that moment will therefore not be
   * cached — it just gets re-read if it is asked for again. Drops happen
   * only after a write, so this costs nothing measurable and buys not
   * having to reason about which in-flight reads a prefix drop affects.
   */
  function dropPrefix(prefix) {
    for (const key of [...entries.keys()]) {
      if (key.startsWith(prefix)) {
        entries.delete(key);
        forgetStorage(key);
      }
    }
    /* The persisted copy may hold keys this instance never loaded, so the
       stored namespace is searched too rather than only the memory map. */
    if (store) {
      try {
        const doomed = [];
        for (let i = 0; i < store.length; i += 1) {
          const k = store.key(i);
          if (k && k.startsWith(`${PREFIX}${persist}:${prefix}`)) doomed.push(k);
        }
        for (const k of doomed) store.removeItem(k);
      } catch {
        /* Already gone from memory, which is what correctness depends on. */
      }
    }
    epoch += 1;
  }

  /** Put a known value in directly — used after a write we already trust. */
  function set(key, value) {
    remember(key, value, Date.now());
  }

  return { read, drop, dropPrefix, set };
}