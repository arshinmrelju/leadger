/* =========================================================
   TrustX Ledger — Default service catalog (seed list)
   -----------------------------------------------------------------
   The catalog itself is database-resident: `services/{serviceId}` is
   the single source of truth, and every screen reads it through
   fetchServices(). Nothing here is rendered directly.

   This module is the list a shop starts from, seeded automatically on
   first run (ensureCatalogSeeded in js/ledger.js, called from the
   protected-page shell). The Developer console keeps a button for the
   same job, which doubles as a repair tool.

   Two things make an automatic seed safe to repeat:
     - the seed list is matched by NAME, so anything the shop already
       typed in by hand is left alone, and
     - seeded rows are written to DETERMINISTIC document ids, so two
       devices opening the app at the same moment collide on the same
       document instead of creating two copies of a service.

   After the seed the shop owns the catalog: rename a service, re-price
   it or archive it, and the change lives in Firestore — editing this
   file will not change what the shop already has.

   Deliberately Firebase-free (like js/day-ledger.js) so the tests can
   require it directly in Node.

   Ordering: the `services` schema has no category field — firestore.rules
   pins the document keys with hasOnly([...]) — so groups are expressed as
   a `sortOrder` band instead of a stored category. fetchServices() already
   sorts active-first, then sortOrder, then name, so the bands below are
   what makes the counter's groups appear in order in every picker.
   ========================================================= */

/**
 * Seeded rate. Every default service starts at ₹0 on purpose: the rates
 * are the shop's own, and a wrong number seeded here would silently
 * pre-fill the rate box on every future sale. The console asks for them
 * once, right after the seed.
 */
export const DEFAULT_SERVICE_PRICE_RUPEES = 0;

/**
 * The groups, in counter order. `base` is the first sortOrder of the
 * band; entries step by 10 so a hand-added service can be slotted
 * between two of them later without renumbering.
 *
 * The shop's rate card repeats a few jobs across headings — building tax,
 * possession, income and legal paperwork appear under both "government /
   certificate" and "local / property", and DTP, printing and scanning
 * under both "printing" and "computer / DTP". Those are the same billed
   job, so each one is listed once, under the group the counter reads it
   from first.
 */
const GROUPS = [
  {
    id: "printing",
    label: "Printing & document services",
    base: 100,
    services: [
      ["Normal Printing", "NP"],
      ["Colour / Photo Printing", "CP"],
      ["Scanning", "SC"],
      ["Scan + Print", "SP"],
      ["Photocopy", "PX"],
      ["DTP / Typing", "DT"],
      ["Document Processing", "DP"],
    ],
  },
  {
    id: "computer",
    label: "Computer & DTP services",
    base: 200,
    services: [
      ["Document Formatting", "DF"],
      ["Document Preparation", "DR"],
    ],
  },
  {
    id: "government",
    label: "Government / certificate services",
    base: 300,
    services: [
      ["PCC (Police Clearance Certificate)", "PC"],
      ["Income Certificate", "IC"],
      ["Possession Certificate", "PO"],
      ["Building Tax", "BT"],
      ["E-Challan", "EC"],
      ["PAN Card Work", "PN"],
      ["Legal Document Work", "LG"],
    ],
  },
  {
    id: "online",
    label: "Online application / digital services",
    base: 400,
    services: [
      ["Online Application", "OA"],
      ["Government Portal Work", "GP"],
      ["Form Filling", "FF"],
      ["Document Uploading", "DU"],
      ["Print Application Copy", "AP"],
      ["Download / Print Certificate", "DC"],
    ],
  },
  {
    id: "photo",
    label: "Photo services",
    base: 500,
    services: [
      ["Passport Size Photo", "PS"],
      ["Photo Printing", "PH"],
      ["Photo Editing", "PE"],
    ],
  },
];

/** Group metadata (id / label / base sortOrder), in counter order. */
export const SERVICE_CATALOG_GROUPS = Object.freeze(
  GROUPS.map((g) => Object.freeze({ id: g.id, label: g.label, base: g.base }))
);

/** Firestore path prefix for seeded service documents. */
export const SERVICE_SEED_PREFIX = "svc_seed_";

/**
 * The comparison key for "does the shop already have this service?".
 * Case and whitespace are not meaningful in a service name, so
 * "PCC" and "pcc " are the same service — otherwise a seed run would
 * duplicate every entry the shop typed in by hand with different casing.
 */
export function catalogKey(name) {
  return String(name ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Readable part of a seed id: "PCC (Police Clearance Certificate)" -> "pcc_police_clearance_certificate". */
function slugify(name) {
  const slug = catalogKey(name)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/g, "");
  return slug || "service";
}

/**
 * FNV-1a over the name. Only there to keep two different services from
 * ever sharing a slug, so it does not need to be a cryptographic hash —
 * it just has to be stable across loads and devices.
 */
function shortHash(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

/**
 * The Firestore document id a catalog entry is seeded to.
 *
 * Deterministic on purpose: two devices running the seed at the same
 * moment write the SAME path, so the second write is refused by the
 * rules (an update must preserve createdAt/createdBy) instead of
 * producing a duplicate service. Also the marker for "already seeded" —
 * a renamed default keeps its id, so it is never seeded a second time.
 */
export function catalogSeedId(name) {
  return SERVICE_SEED_PREFIX + slugify(name) + "_" + shortHash(catalogKey(name));
}

/**
 * The seed list: one frozen entry per service, already flattened into
 * counter order.
 *
 * `code` is the two-letter tile on the quick grids (the UI truncates it
 * to two characters), so it is chosen to read clearly at a glance — it
 * is a display shortcut, not an inventory code.
 */
export const SERVICE_CATALOG = Object.freeze(
  GROUPS.flatMap((group) =>
    group.services.map(([name, code], index) => {
      const seedId = catalogSeedId(name);
      return Object.freeze({
        name,
        code,
        seedId,
        group: group.id,
        price: DEFAULT_SERVICE_PRICE_RUPEES,
        sortOrder: group.base + index * 10,
      });
    })
  )
);

/**
 * Which catalog entries the shop does not have yet.
 *
 * Two ways an entry can already be covered, and both must be checked:
 *   - by NAME, for a service the shop typed in by hand (random id), and
 *   - by SEED ID, for a default that was already seeded and has since
 *     been renamed — its name no longer matches the list.
 *
 * Archived services count as present on purpose: the rules never allow a
 * delete (removal is `active: false`), so a renamed-back service must not
 * be resurrected as a second live row. Pass the INCLUSIVE list —
 * fetchServices({ includeInactive: true }).
 *
 * @param {Array<{name?: string, serviceId?: string}>} existing
 * @returns {object[]} the missing SERVICE_CATALOG entries, in order
 */
export function findMissingCatalogServices(existing) {
  const rows = (Array.isArray(existing) ? existing : []).filter(Boolean);
  const haveNames = new Set(
    rows.filter((s) => typeof s.name === "string").map((s) => catalogKey(s.name))
  );
  const haveIds = new Set(
    rows.filter((s) => typeof s.serviceId === "string").map((s) => s.serviceId)
  );
  return SERVICE_CATALOG.filter(
    (entry) => !haveNames.has(catalogKey(entry.name)) && !haveIds.has(entry.seedId)
  );
}
