/* =========================================================
   Owner console (admin.html) — contract tests
   -----------------------------------------------------------------
   admin.html is a shell page whose middle is drawn by js/admin.js,
   so nothing in the existing suite can catch the two ways that
   arrangement goes wrong: an id in js/admin.js that the page does not
   have (a null dereference that only shows up on a phone), and a
   pane or chip that exists in one file and not the other (a chip that
   opens nothing).

   The gate is asserted here too. The shell checks that a browser is
   signed in and enrolled, but the admin role is the console's own:
   if the proof is ever dropped from js/admin.js, or the shell's
   requireAdmin flag is ever dropped from admin.html, this page would
   be the only unprotected screen in the app and nothing else would
   say so. Both halves are checked, because either one alone is not a
   gate — the shell's flag without the promotion path locks the owner
   out, and the promotion path without the flag would hand the role to
   any enrolled browser that asked.
   ========================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { shiftDayKey, monthBounds } from "../js/calendar.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const html = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
const mod = fs.readFileSync(path.join(ROOT, "js", "admin.js"), "utf8");

/** A file straight off disk, for the assertions that reach past this page. */
function readFile(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8");
}

/** Every `id="..."` on the page. */
function pageIds() {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

/** Every `#id` the module reaches for through getElementById. */
function lookedUpIds() {
  return [...mod.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
}

/** Every `querySelector` the module uses, turned into the id it must find. */
function queriedIds() {
  return [...mod.matchAll(/querySelector\(\s*"#([A-Za-z0-9_-]+)"\s*\)/g)].map((m) => m[1]);
}

/**
 * The page with its comments taken out.
 *
 * Both kinds matter here: admin.html explains itself in an HTML comment
 * above <body> AND in a JS comment inside the module script, and both
 * mention the shell on purpose. A test that matched the word would fail on
 * the explanation rather than on the behaviour.
 */
function codeOnly(source) {
  return source.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Comments and string literals gone, which is what makes a bare-word scan
 * meaningful: without this, "js/admin.js" in a comment reads as an object
 * called `admin` and every file path in the header becomes a false positive.
 * Template and quote literals are dropped whole; `//` line comments too.
 */
function jsCodeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

const htmlCode = codeOnly(html);
const modCode = jsCodeOnly(mod);

/* =========================================================
   The page and the module agree
   ========================================================= */

test("every element the owner console reaches for is on the page", () => {
  const ids = pageIds();
  const missing = [...new Set([...lookedUpIds(), ...queriedIds()])]
    .filter((id) => !ids.has(id))
    .sort();
  assert.deepEqual(missing, [], `admin.html is missing: ${missing.join(", ")}`);
});

test("the console is painted by the app shell, like every other screen", () => {
  /* Parallel to the dashboard by construction, not by resemblance: the
     shell draws the sidebar, top bar, user chip and mobile tab bar, and
     hands the console its context. A page that stopped booting through
     the shell would keep looking right while losing the gate it now
     shares with the rest of the app. */
  assert.ok(
    /from\s*"\.\/js\/shell\.js"/.test(htmlCode),
    "admin.html must import initAppShell() from js/shell.js",
  );
  assert.ok(
    /initAppShell\s*\(/.test(htmlCode),
    "admin.html must boot through initAppShell()",
  );
  assert.ok(
    /requireAdmin\s*:\s*true/.test(htmlCode),
    "the shell must be asked to resolve the admin role (expected requireAdmin: true)",
  );
  assert.ok(
    /onReady\s*:\s*async\s*\(\s*ctx\s*\)\s*=>/.test(htmlCode),
    "the shell must be handed the console as its onReady(ctx)",
  );
  assert.ok(
    /renderOwnerConsole\(/.test(mod),
    "js/admin.js must export renderOwnerConsole(ctx)",
  );
  /* The shell owns the business-day clock; the console must not run a
     second one, or the two would disagree about when today changed. */
  assert.ok(!/setInterval\s*\(/.test(mod), "js/admin.js must not run its own rollover timer");
  /* The shell's user chip is the sign-out now. A console that drew its
     own would be a second account button, and one that still reached
     for the old topbar ids would write into nothing. */
  assert.ok(
    !/\bownDate\b|\bownShopName\b|\bownSignout\b/.test(mod),
    "js/admin.js still reaches for topbar ids the shell owns",
  );
  assert.ok(
    /id="userChip"/.test(html) && /id="topbarDate"/.test(html) && /id="topbarShop"/.test(html),
    "admin.html must carry the shell's user chip and topbar pills",
  );
  assert.ok(
    /class="sidebar"/.test(html) && /id="sidebarBackdrop"/.test(html),
    "admin.html must carry the shell's sidebar",
  );
});

test("each chip has a pane and each pane has a chip", () => {
  const chips = [...mod.matchAll(/\{\s*id: "([a-z]+)",[\s\S]*?label: "[^"]+"/g)].map((m) => m[1]);
  const panes = new Set([...html.matchAll(/data-pane="([a-z]+)"/g)].map((m) => m[1]));

  assert.deepEqual(chips.length, 4, "the console is four sections; a fifth needs a pane too");
  assert.deepEqual(
    chips.filter((id) => !panes.has(id)),
    [],
    "chips with no pane in admin.html",
  );
  assert.deepEqual(
    [...panes].filter((id) => !chips.includes(id)).sort(),
    [],
    "panes in admin.html that no chip can reach",
  );
});

test("the sidebar carries one console link, and the chips stay inside the receipt", () => {
  /* Four sidebar links to four states of one page would put this page
     back in the shop's daily navigation, which is where it was
     deliberately kept out of. */
  assert.deepEqual(
    [...html.matchAll(/data-nav="admin"/g)].length,
    1,
    "admin.html must have exactly one sidebar link marked active",
  );
  assert.ok(
    /class="own-chips" id="ownTabs"/.test(html),
    "the four sections must be chips inside the sheet (expected class=\"own-chips\" id=\"ownTabs\")",
  );
  assert.ok(
    !/class="own-tabs"/.test(html) && !/own-tab\b/.test(html),
    "the old fixed bottom tab bar must be gone now that the shell draws one",
  );
  /* The receipt, not a second layout: the figures are the dashboard's
     own stat cards, so a change to the card lands on both pages. */
  assert.ok(
    /\bstat-card\b/.test(mod) &&
      /stat-icon-wrap icon-/.test(mod) &&
      /stat-value/.test(mod) &&
      /stat-emphasis/.test(mod),
    "js/admin.js must print the dashboard's own stat cards",
  );
  assert.ok(
    /\breceipt-card\b/.test(html) && /\breceipt-tear-edge\b/.test(html) && /\bdash-receipt-wrapper\b/.test(html),
    "the console must sit on a receipt sheet like the dashboard's",
  );
});

test("the console still asks the backend for the admin role", () => {
  /* Its own gate. Without the proof, any enrolled browser could read the
     service list and the trust registry, and revoke a real device. The
     shell resolves role === 'admin' into ctx.isAdmin; the promotion is
     still ours, and the refusal still has to land as a page. */
  assert.ok(/ctx\.isAdmin/.test(mod), "the console must decide on the shell's ctx.isAdmin");
  assert.ok(
    /if\s*\(\s*!\s*ctx\s*\.\s*isAdmin\s*\)/.test(mod),
    "the admin role must be checked against the shell's read of the grant, not assumed (expected `if (!ctx.isAdmin)`)",
  );
  assert.ok(/grantAdminAccess\(\)/.test(mod), "the console must ask for the admin role");
  assert.ok(
    /grant\.role\s*===\s*"admin"/.test(readFile("js", "shell.js")),
    "the shell must resolve the admin role from the grant, not from a session",
  );
  assert.ok(
    /renderLocked\(\)/.test(mod),
    "a refused admin proof must render the locked card",
  );
});

test("the free-plan meter and the all-data browser are gone, not moved", () => {
  /* Both were dropped when this page was rebuilt: neither answers a question
     about the shop. Leaving either importable would leave their markup
     reachable again by accident. */
  assert.ok(!/from\s*"\.\/quota\.js"/.test(mod), "the console should not read the quota meter");
  assert.ok(!/subscribeUsage|resetUsage|getUsage/.test(mod), "a quota readout crept back in");
  assert.ok(
    !/\bdataTxnBody\b|\bdataExpBody\b/.test(mod),
    "the all-data transaction browser is still in the console",
  );
  assert.ok(!/id="dataCard"|id="quotaCard"/.test(html), "a dropped card is still on the page");
});

test("the month report reads expenses for the month it is showing", () => {
  /* A month net that quietly forgot to subtract expenses is worse than no
     net at all, so the read is required and the failure is reported rather
     than swallowed into a zero. */
  assert.ok(/fetchMonthExpenses\(/.test(mod), "the month figures must subtract expenses");
  assert.ok(
    /expensesKnown\s*=\s*false/.test(mod),
    "a failed expense read must be surfaced, not treated as no expenses",
  );
});

test("no figure that depends on expenses is printed without its guard", () => {
  /* fetchTodaySummary() leaves expensesPaise at 0 when the Realtime Database
     read fails and says so with expensesUnavailable, because the day had no
     expenses and "could not read them" are otherwise the same number. Every
     net in the console is derived from that 0, so each one has to sit behind
     the flag. Dropping a guard here is a wrong number on screen, not a crash
     — which is why it needs pinning here rather than left to review. */
  const guarded = /(?:todayExpensesKnown|expensesKnown)\s*\?/;
  const derived = [
    "formatINR(summary.netPaise)",
    "formatINR(summary.expensesPaise)",
    "formatINR(collected - monthExpenses)",
  ];
  for (const expr of derived) {
    const lines = modCode.split("\n").filter((line) => line.includes(expr));
    assert.ok(lines.length > 0, `expected the console to show ${expr}`);
    for (const line of lines) {
      assert.match(line, guarded, `${expr} is printed with no check on the expenses flag: ${line.trim()}`);
    }
  }
});

test("the ledger marks a day's expenses as unread rather than as zero", () => {
  const ledger = jsCodeOnly(fs.readFileSync(path.join(ROOT, "js", "ledger.js"), "utf8"));
  /* Anchored on the surrounding function names, not the doc comments: this
     body is sliced out of comment-stripped source, where a comment cannot be
     found. */
  const body = ledger.slice(
    ledger.indexOf("export async function fetchTodaySummary"),
    ledger.indexOf("export async function fetchTransactions"),
  );
  assert.ok(body.length > 0, "fetchTodaySummary should still exist");
  assert.match(
    body,
    /catch[^{]*\{[^}]*expensesUnavailable\s*=\s*true/s,
    "a failed expense read has to set the flag, or it is indistinguishable from no expenses",
  );
  assert.match(ledger, /expensesUnavailable:\s*false/, "emptySummary must default the flag");

  /* Three ways out of this function: a valid head, an absent head, and the
     folded-rows fallback. Each returns a summary whose expensesPaise is 0 when
     the read failed, so each has to carry the flag too — a path that forgets
     it hands the console a net that is too high and looks entirely normal.
     Checked per segment rather than by counting, so renaming a local or
     reordering the paths does not quietly weaken the assertion. */
  const returns = [...body.matchAll(/\breturn\s+[A-Za-z_$][\w$]*\s*;/g)];
  assert.equal(returns.length, 3, "fetchTodaySummary has three return paths");
  let cursor = 0;
  for (const r of returns) {
    assert.match(
      body.slice(cursor, r.index),
      /expensesUnavailable\s*=/,
      "a return path does not carry the expenses flag",
    );
    cursor = r.index;
  }
});

test("a finished month is judged whole, not up to its last entry", () => {
  /* A past month used to be scanned only as far as the last day with
     something on it, which quietly declared every later day outside the
     ledger — the exact gap the Month screen exists to surface. The month
     length comes from calendar.js rather than a second copy of the rule. */
  assert.ok(
    /monthBounds\(yearMonth\)\.days/.test(mod),
    "the gap scan must use the real length of the month",
  );
  assert.ok(
    !/recorded\[recorded\.length - 1\]/.test(mod),
    "the gap scan must not stop at the last recorded day",
  );

  /* And the helper itself, including the case that makes it worth sharing. */
  assert.deepEqual(monthBounds("2026-02"), {
    yearMonth: "2026-02",
    firstKey: "2026-02-01",
    lastKey: "2026-02-28",
    days: 28,
  });
  assert.equal(monthBounds("2024-02").days, 29, "leap February");
  assert.equal(monthBounds("2026-12").days, 31, "December");
  assert.equal(monthBounds("2026-04").days, 30, "April");
});

test("a day with no head cannot be closed from the console", () => {
  /* closeDay() refuses a headless day, so the button must be hidden rather
     than left to fail after a confirm the owner already answered. */
  assert.match(mod, /if\s*\(!head\)\s*\{/, "the Day pane must branch on a missing head");
  assert.match(mod, /toggle\.hidden\s*=\s*true/, "the Close/Re-open button must hide when there is no day");
});

/* =========================================================
   No half-scoped references

   js/admin.js is one module holding four panes' worth of local state —
   `out`, `boot`, `pill`, `toggle`, `list` — each declared inside the
   function that owns it. A pane that reaches for a sibling's local is a
   ReferenceError that only fires on the path that reaches it, so it
   survives review, passes every other test, and ships.

   The first version of this check collected every declared name in the
   whole file and reported the undeclared ones. That looks like it works
   and does not: `out` is declared in three other functions, so the exact
   bug it was written for sailed through and the test sat there green.
   Hence the scope walk below. Visibility is per-function, which is the
   only granularity that tells the two cases apart.

   It is a lexical approximation, not a type checker. `let` bindings are
   treated as function-wide, so a genuine use-before-declaration is not
   reported — that error is obvious at the call site and rare; borrowing
   a neighbour's local is neither.
   ========================================================= */

const BROWSER_GLOBALS = new Set([
  "document", "window", "console", "Math", "Number", "String", "Boolean",
  "Object", "Array", "JSON", "Date", "RegExp", "Error", "Promise", "Map",
  "Set", "Intl", "URL", "URLSearchParams", "CSS", "isNaN", "parseInt",
  "parseFloat", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
]);

const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Names bound by a binding pattern: `x`, `{ a, b: c }`, `[d, , e]`.
 */
function namesBound(pattern) {
  return pattern
    .split(",")
    .map((part) => part.trim().split(/[:=\s]/)[0].trim().replace(/^\.\.\./, ""))
    .filter((name) => IDENT.test(name));
}

/**
 * Every `name.property` in `code` that resolves to nothing at that point
 * in the file. Returns a list of "name@line" strings.
 *
 * Walks braces once to build the scope stack, then walks the dotted reads
 * against it. Positions are compared as byte offsets, which is why the
 * events are collected first and merged by index rather than by nesting.
 */
function undeclaredReferences(code, globals) {
  const events = [];

  for (let i = 0; i < code.length; i++) {
    if (code[i] === "{") events.push({ i, kind: "open" });
    else if (code[i] === "}") events.push({ i, kind: "close" });
  }

  const declRe = /\b(?:const|let|var|function|class)\s*(?:([A-Za-z_$][\w$]*)|\{([^}]*)\}|\[([^\]]*)\])/g;
  for (const m of code.matchAll(declRe)) {
    const pattern = m[1] || m[2] || m[3] || "";
    events.push({ i: m.index, kind: "decl", names: namesBound(pattern) });
  }

  /* `[^()]` not `[^)]`: a greedy `[^)]*` starts at the enclosing call's
     paren, swallows "async (event", and calls the parameter unnamed.

     The trailing group separates the two arrow shapes. `(s) => "x"` has no
     brace at all — its scope opens nowhere, and if the walk waits for a `{`
     it parks the parameter in whatever block comes next and reports the
     body's own use of it as undeclared. */
  const paramRe = /\(([^()]*)\)\s*(=>|\{)/g;
  for (const m of code.matchAll(paramRe)) {
    events.push({ i: m.index, kind: "params", names: namesBound(m[1]), brace: m[2] === "{" });
  }

  for (const m of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
    events.push({ i: m.index, kind: "decl", names: [m[1]] });
  }

  /* A parameter list is matched at its `(`, which sorts before the `{` that
     opens the body, so params land in the scope about to be pushed. */
  events.sort((a, b) => a.i - b.i || (a.kind === "params" ? 1 : -1));

  const scopes = [{ names: new Set(globals) }];
  const found = [];
  let next = 0;
  let pending = null;

  /* Bare reads only: `name.prop`, not `.length`, not `a.b.c`'s tail, not an
     optional chain, and never a property named with a leading capital since
     every such read in this module is `SOME_CONST` or `SomeClass.method`. */
  const readRe = /(?<![\w.$?])([a-z][\w$]*)\s*\.\s*[A-Za-z_$]/g;

  for (const m of code.matchAll(readRe)) {
    const at = m.index;
    while (next < events.length && events[next].i <= at) {
      const e = events[next++];
      if (e.kind === "open") {
        scopes.push({ names: new Set(pending || []) });
        pending = null;
      } else if (e.kind === "close") {
        if (scopes.length > 1) scopes.pop();
      } else if (e.kind === "decl") {
        const top = scopes[scopes.length - 1];
        for (const n of e.names) top.names.add(n);
      } else if (e.kind === "params") {
        /* An arrow's parameters are added to the enclosing scope and left
           there: an expression-bodied arrow has no block to attach them to,
           and pinning them to one would invent errors in every `.map()` whose
           callback returns a string. They stay narrower than a block only
           where a block exists. Leaking upward is the safe direction — it can
           hide a shadowed name within one function, never a sibling's local,
           which is the mistake worth catching. */
        const top = scopes[scopes.length - 1];
        for (const n of e.names) top.names.add(n);
        if (e.brace) pending = e.names;
      }
    }
    if (!scopes.some((s) => s.names.has(m[1]))) {
      found.push(m[1] + "@" + code.slice(0, at).split("\n").length);
    }
  }
  return found;
}

test("the half-scoped guard itself can still fail", () => {
  /* A guard that cannot fail is worse than no guard, because it is trusted.
     This proves the walk reports a sibling's local and clears a name that is
     genuinely in scope. */
  const sibling = `
    function first() { const out = document.getElementById("a"); return out.value; }
    function second() { out.innerHTML = "x"; }
  `;
  const honest = `
    function second(btn) { const out = document.getElementById("a"); out.innerHTML = btn.value; }
  `;
  assert.deepEqual(undeclaredReferences(jsCodeOnly(sibling), BROWSER_GLOBALS), ["out@3"]);
  assert.deepEqual(undeclaredReferences(jsCodeOnly(honest), BROWSER_GLOBALS), []);
});

test("the console never reads off a local belonging to another function", () => {
  const globals = new Set(BROWSER_GLOBALS);
  for (const m of modCode.matchAll(/^import\s*\{([^}]*)\}/gm)) {
    for (const name of namesBound(m[1])) globals.add(name);
  }
  assert.deepEqual(
    undeclaredReferences(modCode, globals),
    [],
    "read off something that is not in scope here",
  );
});

/* =========================================================
   The stepper's arithmetic

   The Day tab's arrows are the only way to reach an older day without a
   calendar, so this is shared with js/calendar.js's own grid rather than
   reimplemented — one arithmetic, one set of tests.
   ========================================================= */

test("the day stepper moves a day at a time and knows the length of a month", () => {
  assert.equal(shiftDayKey("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDayKey("2026-03-01", 1), "2026-03-02");
  assert.equal(shiftDayKey("2026-02-28", 1), "2026-03-01");
  assert.equal(shiftDayKey("2026-12-31", 1), "2027-01-01");
  /* 2028 is a leap year; 2026 is not. Getting this wrong is a day that
     does not exist, which the date input then refuses. */
  assert.equal(shiftDayKey("2028-02-28", 1), "2028-02-29");
  assert.equal(shiftDayKey("2028-02-29", -1), "2028-02-28");
  assert.equal(shiftDayKey("2026-02-28", 1), "2026-03-01");
});

test("the stepper always returns a valid date key", () => {
  for (const key of ["2026-01-01", "2026-04-30", "2026-12-31", "2027-03-15"]) {
    for (const step of [-370, -31, -1, 0, 1, 31, 370]) {
      assert.match(shiftDayKey(key, step), /^\d{4}-\d{2}-\d{2}$/, `${key} ${step}`);
    }
  }
});
