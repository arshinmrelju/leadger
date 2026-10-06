/* =========================================================
   Module-graph guard.
   -----------------------------------------------------------------
   `node --check` only validates syntax, so a module that imports a
   name another module does not export passes every other check and
   then fails in the browser with a LINK-TIME error — which kills the
   whole module graph before any code runs. That is how every
   protected screen once sat on its "Loading..." spinner: js/ledger.js
   imported `isValidDateKey` from js/day-ledger.js, which never
   exported it.

   This test walks the real import graph (HTML entry scripts AND
   JS -> JS imports) and asserts every named import resolves to a real
   export, so that class of bug fails here instead of at runtime.

   It is a static, regex-based check — deliberately conservative about
   what it inspects. Anything it cannot parse confidently is skipped
   rather than guessed at.
   ========================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every name a module exports, following re-exports. */
function exportsOf(fullPath, seen = new Set()) {
  if (seen.has(fullPath)) return new Set();
  seen.add(fullPath);
  if (!fs.existsSync(fullPath)) return null; // missing file, not a bad name
  const src = fs.readFileSync(fullPath, "utf8");
  const names = new Set();

  for (const m of src.matchAll(
    /export\s+(?:async\s+)?function\s+(\w+)|export\s+(?:const|let|var)\s+(\w+)|export\s+class\s+(\w+)/g,
  )) {
    names.add(m[1] || m[2] || m[3]);
  }

  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }

  if (/export\s+default/.test(src)) names.add("default");

  // export { x } from "./y.js"  and  export * from "./y.js"
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const dep = exportsOf(path.resolve(path.dirname(fullPath), m[2]), seen);
    if (!dep) continue;
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  for (const m of src.matchAll(/export\s*\*\s*from\s*["']([^"']+)["']/g)) {
    const dep = exportsOf(path.resolve(path.dirname(fullPath), m[2]), seen);
    if (dep) for (const n of dep) names.add(n);
  }

  return names;
}

/** Every source file that can be an entry point, with its own code. */
function* entryPoints() {
  for (const name of fs.readdirSync(ROOT)) {
    if (!name.endsWith(".html")) continue;
    const full = path.join(ROOT, name);
    const html = fs.readFileSync(full, "utf8");
    const blocks = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .join("\n");
    yield { label: name, full, code: blocks };
  }

  const walk = function* (dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") yield* walk(full);
      } else if (/\.(?:js|mjs)$/.test(entry.name)) {
        yield {
          label: path.relative(ROOT, full),
          full,
          code: fs.readFileSync(full, "utf8"),
        };
      }
    }
  };
  yield* walk(ROOT);
}

test("every named import in the app resolves to a real export", () => {
  const problems = [];

  for (const { label, full, code } of entryPoints()) {
    const re = /import\s+(?:(\*\s+as\s+\w+)|\{([^}]*)\}|(\w+))\s+from\s*["'](\.[^"']+)["']/g;

    for (const m of code.matchAll(re)) {
      const [, star, braces, , specifier] = m;
      if (star || !braces) continue; // namespace / default import

      const target = path.resolve(path.dirname(full), specifier);
      const available = exportsOf(target);
      if (available === null) {
        problems.push(`${label}: cannot resolve "${specifier}"`);
        continue;
      }

      for (const part of braces.split(",")) {
        const t = part.trim();
        if (!t) continue;
        const name = t.split(/\s+as\s+/)[0].trim();
        if (!available.has(name)) {
          problems.push(`${label}: "${name}" is not exported by ${specifier}`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], `unresolved imports:\n  ${problems.join("\n  ")}`);
});

test("the day layer and the data layer agree on the date-key source", () => {
  /* The bug above came from a day helper being reachable through two
     paths. Pin the single source of truth so it cannot drift again. */
  const ledgerSrc = fs.readFileSync(path.join(ROOT, "js", "ledger.js"), "utf8");
  assert.match(
    ledgerSrc,
    /import\s*\{[^}]*\bisValidDateKey\b[^}]*\}\s*from\s*["']\.\/utils\.js["']/,
    "js/ledger.js should import isValidDateKey from ./utils.js",
  );
  assert.doesNotMatch(
    ledgerSrc,
    /import\s*\{[^}]*\bisValidDateKey\b[^}]*\}\s*from\s*["']\.\/day-ledger\.js["']/,
    "js/ledger.js must not import isValidDateKey from ./day-ledger.js (it is not re-exported)",
  );
});

/* =========================================================
   Modal-visibility guard.

   css/style.css holds `.modal-overlay` at `visibility: hidden` and only
   reveals it on `.modal-overlay.is-open`, and `openModal()` is what adds
   that class. So a dynamically built overlay that is merely appended to
   the page is present, sized, and completely unclickable.

   That is invisible to every other check here, and it failed silently
   in the worst possible way: the shared `confirm()` in js/app.js did
   exactly that, so all eight confirmation dialogs in the app - delete
   a sale, mark a due paid, and all five in js/admin.js - opened as
   nothing at all. The caller's promise never settled, so the write it
   was guarding never ran, and a Delete button produced no dialog, no
   error, and no sale deleted.

   The test is scoped to `confirm()`'s own body on purpose. A file-level
   check would pass either way: js/app.js is where `openModal` is
   defined, so the name is present in the file regardless of whether
   `confirm` calls it. Body-scoped, it pins the actual contract.
   ========================================================= */

test("the shared confirm() opens its overlay, so it is actually visible", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
  const start = src.indexOf("export function confirm(");
  assert.notEqual(start, -1, "js/app.js should still export confirm()");

  /* Up to the next top-level export, or the end of the file. */
  const rest = src.slice(start + 1);
  const nextExport = rest.search(/\nexport\s/);
  const body = nextExport === -1 ? rest : rest.slice(0, nextExport);

  assert.match(
    body,
    /openModal\(\s*\w+\s*\)/,
    "confirm() must open its overlay through openModal(); appending it alone leaves it " +
      "visibility:hidden, so the dialog never appears and the guarded write never happens",
  );
  assert.doesNotMatch(
    body,
    /openOverlays\.push\(/,
    "confirm() should let openModal() track the overlay in openOverlays, not push it directly",
  );
});

/* =========================================================
   Quota-salvage modal dismissal guard.

   js/app.js delegates one document-level click handler that closes ANY
   `.modal-overlay` when the click landed on the overlay itself — the
   standard backdrop-dismiss. The salvage dialog in js/sale-form.js is
   deliberately NOT dismissible that way: it has no close button, and the
   only way out is an explicit "I have written it down" click, so that
   acknowledging the dialog is a decision rather than a reflex.

   Nothing in that file's own code would catch a regression here, because
   the handler that breaks the promise lives in a different module and the
   dialog builds and appends its markup perfectly well. The failure is also
   the expensive kind: a stray click beside the dialog dismisses it, the
   shopkeeper reads the sale summary and clicks away, and a sale that was
   never saved is lost with no error anywhere.
   ========================================================= */

test("the quota salvage dialog cannot be dismissed by clicking beside it", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "sale-form.js"), "utf8");
  const start = src.indexOf("function showQuotaSalvageModal(");
  assert.notEqual(start, -1, "js/sale-form.js should still define the salvage dialog");

  const rest = src.slice(start + 1);
  const nextFn = rest.search(/\n(?:function|export)\s/);
  const body = nextFn === -1 ? rest : rest.slice(0, nextFn);

  assert.match(
    body,
    /overlay\.addEventListener\(\s*"click"[\s\S]{0,120}stopPropagation/,
    "the salvage dialog must stop click propagation, or app.js's document-level " +
      "backdrop handler closes it and the shopkeeper loses an unsaved sale",
  );

  /* And the escape route must stay closed too: only the button removes it. */
  assert.match(
    body,
    /data-ack[\s\S]{0,400}addEventListener\(\s*"click"\s*,\s*done\s*\)/,
    "the dialog should still be dismissed by its acknowledgement button",
  );
});

/* =========================================================
   Dead-export guard (the mirror image of the check above).

   An export nothing imports is the cheapest kind of rot in a bundled-
   free app: it survives every refactor, still shows up in the module
   graph, and quietly costs a reader's trust. A repo this size carried
   fourteen of them until this test existed.

   The bar is deliberately high, so the test does not cry wolf:
     - tests/ counts as a real consumer, so helpers kept for their
       unit tests (statusForMethod, MAX_*) stay;
     - HTML entry scripts count, so page-level wiring stays;
     - a name used inside its own module counts, because making a
       module's internals importable is a deliberate act, not rot.
   Anything else has to earn its place via the allowlist below.
   ========================================================= */

/** Exports that are public on purpose and have no importer. */
const INTENTIONAL_PUBLIC = new Set([
  /* The seeded default codes. auth.js uses both internally to write
     settings/security and settings/admin; they are exported so the
     values are discoverable and greppable from one place. */
  "SHOP_CODE",
  "ADMIN_CODE",
]);

test("no module exports a name that nothing imports", () => {
  const points = [...entryPoints()];

  /* Names each module exports, for every module (keyed by absolute path). */
  const exportsByFile = new Map();
  for (const { full } of points) {
    if (!full.endsWith(".js")) continue;
    exportsByFile.set(full, exportsOf(full));
  }

  /* usedBy: absolute path -> names some OTHER file imports from it. */
  const usedBy = new Map();
  for (const key of exportsByFile.keys()) usedBy.set(key, new Set());
  const credit = (target, name) => {
    if (!target) return;
    const set = usedBy.get(target);
    if (set) set.add(name);
  };

  for (const { full, code } of points) {
    const re = /import\s+(?:(?:\*\s+as\s+\w+)|\{([^}]*)\}|(\w+))\s+from\s*["'](\.[^"']+)["']/g;
    for (const m of code.matchAll(re)) {
      if (!m[1]) continue; // namespace / default import
      /* Credit the file the name comes FROM, not the one importing it. */
      const target = path.resolve(path.dirname(full), m[3]);
      for (const part of m[1].split(",")) {
        const t = part.trim();
        if (!t) continue;
        credit(target, t.split(/\s+as\s+/)[0].trim());
      }
    }
    // A re-export is a use of the name in the file it came from.
    for (const m of code.matchAll(/export\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(full), m[2]);
      for (const part of m[1].split(",")) {
        const t = part.trim();
        if (!t) continue;
        const alias = t.split(/\s+as\s+/);
        credit(target, (alias[1] || alias[0]).trim());
      }
    }
  }

  const orphans = [];
  for (const [full, exported] of exportsByFile) {
    const label = path.relative(ROOT, full);
    const code = fs.readFileSync(full, "utf8");
    const names = usedBy.get(full);
    for (const name of exported) {
      if (name === "default" || INTENTIONAL_PUBLIC.has(name)) continue;
      if (names.has(name)) continue;
      // Used inside its own module? Fine - that is a private helper that
      // happens to be exported; only flag names nothing references at all.
      const body = code.replace(
        new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`),
        "",
      );
      if (!new RegExp(`\\b${name}\\b`).test(body)) {
        orphans.push(`${label}: export "${name}" is never used`);
      }
    }
  }

  assert.deepEqual(orphans, [], `unused exports:\n  ${orphans.join("\n  ")}`);
});

/* =========================================================
   PWA wiring
   -----------------------------------------------------------------
   The install button failed twice before these tests existed, both times
   because a file was correct on its own but disagreed with another file:
   a CSS specificity problem hid a button that existed, and the shell mounted
   the control after the browser had already spent its one-shot install event.
   Neither shows up in a unit test of the individual file, so these assert the
   agreements between files.
   ========================================================= */

const PAGES = [
  "index.html",
  "login.html",
  "dashboard.html",
  "transactions.html",
  "calendar.html",
  "ledger.html",
  "admin.html",
];

test("every page links the manifest and declares a theme colour", () => {
  const problems = [];
  /* Shop surfaces install to the dashboard; the Owner console is a second
     installable app with its own manifest so desktop shop installs never
     launch into admin.html. */
  const OWNER_PAGES = new Set(["admin.html", "admin-login.html"]);
  for (const page of [...PAGES, "admin-login.html", "offline.html"]) {
    let html;
    try {
      html = fs.readFileSync(path.join(ROOT, page), "utf8");
    } catch {
      problems.push(`${page}: page not found`);
      continue;
    }
    if (!/rel="manifest"/.test(html)) problems.push(`${page}: no <link rel="manifest">`);
    if (!/name="theme-color"/.test(html)) problems.push(`${page}: no theme-color meta`);
    const want = OWNER_PAGES.has(page) ? "manifest-admin.webmanifest" : "manifest.webmanifest";
    if (!html.includes(want)) {
      problems.push(`${page}: manifest link must point at ${want}`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the two manifests launch into their own app", () => {
  const shop = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.webmanifest"), "utf8"));
  const owner = JSON.parse(
    fs.readFileSync(path.join(ROOT, "manifest-admin.webmanifest"), "utf8"),
  );
  assert.equal(shop.start_url, "/dashboard.html", "shop manifest must launch the shop");
  assert.equal(shop.id, "/dashboard.html", "shop manifest id must stay stable");
  assert.equal(owner.start_url, "/admin.html", "owner manifest must launch the console");
  assert.equal(owner.id, "/admin.html", "owner manifest needs its own id, or installs collide");
  assert.notEqual(shop.id, owner.id, "sharing one id merges the two apps into one install");
});

test("the install prompt is captured before any async shell init can run", () => {
  const code = fs.readFileSync(path.join(ROOT, "js", "pwa.js"), "utf8");

  /* `beforeinstallprompt` fires at most once per page load. If the only
     listener sits inside mountPwaControls, then a shell that mounts after an
     await on Firebase Auth has already missed it and the button can never
     light up. A module-level listener is the only thing that is early enough. */
  const moduleLevel = /(?:^|\n)\s*(?:if\s*\([^)]*addEventListener|window\.addEventListener)[\s\S]*?addEventListener\(\s*["']beforeinstallprompt["']/;
  assert.ok(
    moduleLevel.test(code),
    "pwa.js must attach a beforeinstallprompt listener at module load, " +
      "not only inside mountPwaControls",
  );

  /* And mounting late must still find the held prompt. */
  assert.ok(
    /deferredInstallPrompt\s*\)\s*\{[\s\S]{0,120}installBtn\.hidden\s*=\s*false/.test(code),
    "mountPwaControls must show the button when a prompt was already captured",
  );
});

test("a hidden pwa control cannot be shown by the .btn display rule", () => {
  const css = fs.readFileSync(path.join(ROOT, "css", "style.css"), "utf8");

  /* .btn sets `display: inline-flex`, which beats the user-agent's
     `[hidden] { display: none }` because author styles win over the UA sheet.
     Without an explicit reset the install button stays on screen while its
     prompt is still null, and clicking it does nothing. */
  const btnBlock = css.match(/\.btn\s*\{[^}]*\}/);
  assert.ok(btnBlock, ".btn rule not found in css/style.css");
  assert.match(
    btnBlock[0],
    /display\s*:\s*(inline-)?flex/,
    ".btn is expected to set display; the [hidden] reset depends on that",
  );

  assert.ok(
    /\.pwa-control\[hidden\]\s*\{[^}]*display\s*:\s*none\s*;?\s*\}/.test(css),
    "css/style.css must reset .pwa-control[hidden] to display:none, " +
      "otherwise the button is visible but inert",
  );
});

test("the service worker caches only deliberate CDN hosts", () => {
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");

  /* Anything the worker caches is served from disk, so a Firestore or Auth
     response landing in a cache is a correctness bug, not a performance one:
     the shop could read a stale balance and believe it. An allowlist is the
     mechanism that prevents it, so the set is asserted exactly — adding a
     broad suffix match like ".googleapis.com" would silently widen it. */
  const block = sw.match(/VENDOR_HOSTS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, "sw.js must declare a VENDOR_HOSTS allowlist");

  const hosts = [...block[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(
    hosts.sort(),
    ["fonts.googleapis.com", "fonts.gstatic.com", "www.gstatic.com"],
    "VENDOR_HOSTS changed — review why before allowing a new origin",
  );

  /* Belt and braces: the forbidden origins must not appear anywhere near the
     allowlist, in case a second mechanism was added. */
  for (const forbidden of ["firebaseio.com", "identitytoolkit", "securetoken", "googleapis.com/identitytoolkit"]) {
    assert.ok(
      !sw.includes(`"${forbidden}"`),
      `sw.js references ${forbidden}, which must never be cached`,
    );
  }
});

test("the service worker's SDK version matches the import maps", () => {
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const pinned = new Set();

  /* Every page pins the SDK in its import map; the worker has to cache the
     same version or an offline boot imports a version nothing else uses. */
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    for (const m of html.matchAll(/gstatic\.com\/firebasejs\/([\d.]+)\//g)) {
      pinned.add(m[1]);
    }
  }

  assert.ok(pinned.size > 0, "no Firebase version found in any import map");
  assert.equal(
    pinned.size,
    1,
    `pages pin different Firebase versions: ${[...pinned].join(", ")}`,
  );

  const version = [...pinned][0];
  const declared = sw.match(/FIREBASE_VERSION\s*=\s*["']([\d.]+)["']/);
  assert.ok(declared, "sw.js must declare FIREBASE_VERSION");
  assert.equal(
    declared[1],
    version,
    `sw.js caches Firebase ${declared[1]} but the pages pin ${version}`,
  );

  /* Every module a page actually imports must be in the worker's list. */
  const sdkBlock = sw.match(/FIREBASE_SDK\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(sdkBlock, "sw.js must declare a FIREBASE_SDK list");
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    for (const m of html.matchAll(/firebasejs\/[\d.]+\/(firebase-[a-z]+\.js)/g)) {
      assert.ok(
        sdkBlock[1].includes(m[1]),
        `${page} imports ${m[1]} but sw.js does not precache it`,
      );
    }
  }
});

test("firebase.json keeps the worker and its shell out of long-lived HTTP cache", () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "firebase.json"), "utf8"));
  const rules = config.hosting.headers || [];

  const ccFor = (source) => {
    const rule = rules.find((r) => r.source === source);
    if (!rule) return null;
    const hit = rule.headers.find((h) => h.key === "Cache-Control");
    return hit ? hit.value : null;
  };

  /* A cached sw.js is an old worker: the browser would keep serving the
     previous version of every app file, which is how a money-handling fix
     fails to reach the shop. */
  assert.equal(
    ccFor("sw.js"),
    "no-cache",
    "sw.js must be served no-cache or updates cannot roll out",
  );
  assert.equal(
    ccFor("**/*.html"),
    "no-cache",
    "HTML must be no-cache so a reload picks up new markup",
  );

  /* A broad js-glob rule would also match sw.js, and Firebase does not
     document which of two matching Cache-Control values wins — so the rules
     are scoped to directories to remove the ambiguity entirely. */
  assert.equal(
    ccFor("**/*.js"),
    null,
    "a **/*.js rule also matches sw.js and its precedence is undefined; " +
      "scope cache rules to js/** instead",
  );
});

test("deploy ignores the tools directory, which holds admin scripts", () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "firebase.json"), "utf8"));
  const ignore = config.hosting.ignore || [];
  assert.ok(
    ignore.includes("tools/**"),
    "tools/** must be ignored: hosting.public is '.', so those admin scripts " +
      "would be published at the site root",
  );
});

test("every file the worker precaches actually exists", () => {
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const block = sw.match(/SHELL_FILES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(block, "sw.js must declare a SHELL_FILES list");

  const missing = [];
  for (const m of block[1].matchAll(/["']([^"']+)["']/g)) {
    const rel = m[1];
    if (rel.includes("..") || /^https?:/.test(rel)) continue;
    if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
  }
  assert.deepEqual(missing, [], `precached but not on disk: ${missing.join(", ")}`);
});

test("each precached app module is reachable from a page", () => {
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const block = sw.match(/SHELL_FILES\s*=\s*\[([\s\S]*?)\]/);
  const cached = new Set([...block[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]));

  /* A module that is cached but never imported is dead weight in the precache;
     one that is imported but never cached is an offline boot that breaks on
     the first cold start. Both are cheap to detect here. */
  const pages = PAGES.map((p) => fs.readFileSync(path.join(ROOT, p), "utf8")).join("\n");
  const referenced = new Set(
    [...(pages + fs.readFileSync(path.join(ROOT, "js", "shell.js"), "utf8")).matchAll(
      /["']((?:\.\/)?js\/[A-Za-z0-9._-]+\.js)["']/g
    )].map((m) => m[1].replace(/^\.\//, ""))
  );

  const uncached = [...referenced].filter((f) => !cached.has(f));
  assert.deepEqual(
    uncached,
    [],
    `imported by a page but missing from the precache: ${uncached.join(", ")}`,
  );
});
