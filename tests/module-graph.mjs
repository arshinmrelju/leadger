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
