/* =========================================================
   TrustX Ledger — Owner console (admin.html)
   -----------------------------------------------------------------
   A shell page like every other protected screen. The sidebar, top
   bar, user chip, install controls and mobile tab bar come from
   js/shell.js; the console is reached from the sidebar's Management
   section rather than from the shop's daily navigation, and behind
   the same admin role the rules already answer for (see auth.js /
   firestore.rules).

   WHAT IS ITS OWN IS THE PAPER.
   Inside the shell, the four sections sit on the receipt sheet the
   dashboard prints its figures on — same stat cards, same stamp, same
   tear edge — and the sidebar's one "Owner console" link is enough to
   get back here. Switching section is a chip inside the receipt, not
   a page load: the month the owner was reading survives a look at Shop
   and is still there on the way back.

    FOUR SECTIONS, IN THE ORDER THEY ARE NEEDED
       money  — today and the month so far, at a glance: a greeting over
                the month's hero net, the tiles, the collection mix and
                the spending donut, all drawn from figures already read
       month  — one month's days, day by day, with the totals
       day    — close or re-open any day, and check it adds up
       shop   — the services sold, and the browsers allowed to sell

   What this shares with the rest of the app is the arithmetic, the
   caches and the rules: this page reads through js/ledger.js rather
   than talking to Firebase itself, so a rupee shown here is the same
   rupee the day head holds.

   What an owner does NOT need is deliberately absent: the free-plan
   usage meter and the all-data transaction browser went when this
   page was rebuilt, because neither answers a question about the
   shop. See docs/PAGES.md.
   ========================================================= */

import { toast, confirm, setLoading } from "./app.js";
import {
  formatINR,
  formatDateKey,
  formatKolkataTime,
  formatKolkataLong,
  escapeHtml,
  isValidDateKey,
  todayKolkata,
  paiseToInput,
  rateToPaise,
} from "./utils.js";
import {
  currentYearMonth,
  shiftMonth,
  shiftDayKey,
  monthLabel,
  monthBounds,
  dayCellLabel,
} from "./calendar.js";
import { DAY_STATE } from "./day-heads.js";
import {
  auditDayCounters,
  describeAudit,
  planDayRepair,
  AUDIT_STATUS,
} from "./day-audit.js";
import { findMissingCatalogServices, SERVICE_CATALOG } from "./service-catalog.js";
import {
  fetchServices,
  createService,
  seedDefaultServices,
  updateService,
  fetchTransactions,
  fetchMonthHeads,
  fetchMonthExpenses,
  fetchTodaySummary,
  repairDayHead,
  closeDay,
  reopenDay,
} from "./ledger.js";
import {
  reportError,
  listAccessGrants,
  revokeGrant,
  restoreGrant,
  removeGrant,
  grantAdminAccess,
  AuthError,
} from "./auth.js";

/**
 * Icons, keyed by the chip, the figure and the section they belong to.
 *
 * The five figure icons are the dashboard's own paths, copied rather than
 * invented, so the same rupee carries the same mark on both sheets.
 */
function svg(id) {
  const paths = {
    money: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>',
    month: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    day: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    shop: '<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>',
    services: '<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>',
    devices: '<rect x="2" y="4" width="20" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    /* How a sale was paid, for the collection-mix and day-sales rows. */
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10h.01M18 14h.01"/>',
    upi: '<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    /* The dashboard's five figure marks, unchanged. */
    taken: '<path d="M3 17l5-5 4 4 8-8"/><path d="M15 8h5v5"/>',
    collected: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10h.01M18 14h.01"/>',
    due: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    expenses: '<circle cx="12" cy="12" r="9"/><path d="M7 12h10"/><path d="M12 7v10"/>',
    net: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  };
  return (
    '<svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (paths[id] || "") +
    "</svg>"
  );
}

/* =========================================================
   State

   One object, read by every pane. The panes stay in the DOM when
   the tabs switch, so the month the owner was reading survives a
   look at the Shop tab and is still there on the way back.
   ========================================================= */
const state = {
  /** Which of the four panes is on screen. */
  tab: "money",
  /** `YYYY-MM` for the month report and the month-at-a-glance tile row. */
  month: currentYearMonth(),
  /** The business day the Day tab is pointed at. */
  dayKey: todayKolkata(),
  /** This browser's own grant uid, so the registry can say "this browser". */
  thisUid: null,
};

/* =========================================================
   Boot and gate

   The shell has already done the first half of the gate before
   calling in: it resolved the session, proved an active access grant
   (requireAccess), drew the sidebar, top bar, user chip and mobile
   tab bar, and handed us ctx. What is left is the admin role, which
   the shop code does not carry.
   ========================================================= */

/**
 * Paint the console into the shell's page. Called by initAppShell().
 *
 * Only the admin proof is ours. The rules are the only thing that can
 * answer "is this account an admin?", because the allowlist is
 * unreadable by any client — so an admin-scope proof is asked for and
 * the backend decides. A shop account costs one refused write and no
 * UI guesswork; an owner arriving with the right Google account is
 * promoted without leaving the page. ctx.isAdmin is the shell's read
 * of the grant it already fetched, not an assumption from a session.
 */
export async function renderOwnerConsole(ctx) {
  if (!ctx) return;

  state.thisUid = (ctx.grant && ctx.grant.uid) || null;
  mountChips();

  if (!ctx.isAdmin) {
    try {
      await grantAdminAccess();
    } catch (err) {
      /* `not-authorized` is the ordinary answer for a shop account and
         needs no noise. Anything else is a real fault — say so, rather
         than letting it read as "you are simply not the owner". */
      if (!(err instanceof AuthError) || err.code !== "not-authorized") {
        toast(reportError(err), "error");
      }
      renderLocked();
      return;
    }
  }

  showConsole();
  wireMoney();
  wireMonth();
  wireDay();
  wireShop();

  /* The section the browser came back to, so a reload keeps the owner
     where they were rather than dropping them on the default one. */
  const wanted = new URLSearchParams(window.location.search).get("tab");
  await activateTab(TABS.some((t) => t.id === wanted) ? wanted : state.tab);

  /* The shell owns the business-day clock and hands us the tick when it
     rolls over, so a console left open across it cannot go on reporting
     yesterday's takings under a "today" heading. Only the figures are
     re-read: the Day section's arrow deliberately points at days other
     than today and the owner must not be moved off one by the clock. */
  window.addEventListener("seva:owner-day-change", () => {
    if (state.tab === "money") refreshPane();
  });
}

/** Swap the boot screen out for the console, or for the locked card. */
function showConsole() {
  document.getElementById("ownBoot").hidden = true;
  document.getElementById("ownConsole").hidden = false;
}

/**
 * A refused admin proof: the shell stays, the console does not.
 *
 * It lands in #mainContent rather than in the boot screen, because the
 * shell keeps painting this page even after the console has given up —
 * and the owner must still be able to pick another account from the
 * user chip instead of hunting for a sign-out button that the console
 * would have had to draw for itself.
 */
function renderLocked() {
  const boot = document.getElementById("ownBoot");
  const main = document.getElementById("mainContent");
  if (boot) boot.hidden = true;
  const host = main || boot;
  if (!host) return;
  host.hidden = false;
  host.innerHTML =
    '<div class="ledger-loading-screen"><div class="ledger-loading-card">' +
    '<div class="ledger-loading-emblem">' +
    '<div class="emblem-icon own-gate">' +
    svg("day") +
    "</div></div>" +
    "<h2 class=\"ledger-loading-title\">The owner console is locked</h2>" +
    '<p class="ledger-loading-sub">This page keeps the shop&rsquo;s money, its service list and the ' +
    "browsers allowed to open the ledger. Sign in with the owner&rsquo;s Google account to get in.</p>" +
    '<div class="flex" style="gap:.5rem;justify-content:center;flex-wrap:wrap;margin-top:1rem;">' +
    '<a class="btn btn-primary" href="admin-login.html?reason=not-admin">Switch account</a>' +
    '<a class="btn btn-secondary" href="admin-login.html">Sign in to the Owner console</a>' +
    "</div></div></div>";
}

/* =========================================================
   Sections

   Four receipt chips instead of four pages. They sit inside the sheet
   under its title, because they are choices about what to read on this
   sheet, not somewhere else to navigate to — the sidebar already holds
   the one link that says you are in the console at all.

   The title and the line under it follow the chip, so the sheet always
   says which question it is answering.
   ========================================================= */

const TABS = [
  {
    id: "money",
    label: "Money",
    icon: "money",
    title: "Money",
    sub: "Today, and the month so far",
  },
  {
    id: "month",
    label: "Month",
    icon: "month",
    title: "Month",
    sub: "One month, day by day",
  },
  {
    id: "day",
    label: "Day",
    icon: "day",
    title: "Day",
    sub: "Close it, re-open it, and check it adds up",
  },
  {
    id: "shop",
    label: "Shop",
    icon: "shop",
    title: "Shop",
    sub: "What is sold, and who may sell it",
  },
];

function mountChips() {
  const nav = document.getElementById("ownTabs");
  if (!nav) return;
  nav.innerHTML = TABS.map(
    (tab) =>
      '<button class="own-chip" type="button" data-tab="' + tab.id + '">' +
      svg(tab.icon) +
      "<span>" + escapeHtml(tab.label) + "</span>" +
      "</button>",
  ).join("");
  nav.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-tab]");
    if (btn) activateTab(btn.getAttribute("data-tab"));
  });
}

/**
 * Show one section.
 *
 * Only the section being entered is loaded: Month reads a month of day
 * heads, and an owner flicking to Day to close today and back again
 * should not pay for the month twice or sit through the report's table
 * being rebuilt. The chip, the sheet's title and the URL all move
 * together, so a reload and a bookmark land on the same question.
 */
async function activateTab(id) {
  const tab = TABS.find((t) => t.id === id) || TABS[0];
  state.tab = tab.id;

  document.querySelectorAll("#ownTabs .own-chip").forEach((btn) => {
    const active = btn.getAttribute("data-tab") === tab.id;
    btn.classList.toggle("is-active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });

  document.querySelectorAll("#ownConsole .own-pane").forEach((pane) => {
    pane.hidden = pane.getAttribute("data-pane") !== tab.id;
  });

  /* The sheet's own header follows the chip, so the receipt always says
     which question it is answering. */
  const title = document.getElementById("ownPaneTitle");
  const sub = document.getElementById("ownPaneSub");
  if (title) title.textContent = tab.title;
  if (sub) sub.textContent = tab.sub;

  /* Keep the URL honest: a reload, a bookmark and the back button all
     land on the section the owner was actually looking at. */
  const url = new URL(window.location.href);
  if (tab.id === "money") url.searchParams.delete("tab");
  else url.searchParams.set("tab", tab.id);
  window.history.replaceState(null, "", url);

  await refreshPane();
}

async function refreshPane() {
  try {
    if (state.tab === "money") await loadMoney(false);
    else if (state.tab === "month") await loadMonth(false);
    else if (state.tab === "day") await loadDay(false);
    else if (state.tab === "shop") await loadShop();
  } catch (err) {
    console.error("[trustx-ledger] owner console pane:", err);
    toast(reportError(err), "error");
  }
}

/* =========================================================
   Money — today and the month so far
   -----------------------------------------------------------------
   Two questions, in this order: how did today go, and how is the
   month shaping up. Both are answered off the day heads rather than
   off the sales: a head already carries a day's count and totals, so
   a month is one ranged read no matter how busy each day was.

   Outstanding dues are NOT totalled across all time here. Doing that
   honestly means reading every unpaid sale in the ledger, which is the
   single most expensive thing this app can do; so the tile reports
   today's dues, which are free, and links to the Sales screen for the
   full list.
   ========================================================= */

/**
 * The five figures the console ever prints, and the dashboard's icon
 * scheme each one wears. A fixed vocabulary on purpose: every section
 * answers the same five questions, so a new figure is a new entry here
 * and in the style sheet, not another colour invented at a call site.
 */
const FIGURE = {
  taken: { icon: "revenue", card: "stat-revenue" },
  collected: { icon: "cash", card: "" },
  due: { icon: "due", card: "stat-due" },
  expenses: { icon: "expenses", card: "stat-expenses" },
  net: { icon: "net", card: "stat-net" },
};

/**
 * A money figure, in the dashboard's own stat card.
 *
 * Not a parallel set of styles: it is the same markup the dashboard
 * prints its figures with, so a rupee looks the same on both sheets and
 * a change to the card lands on both. `wide` spans two columns, which is
 * how the two headline figures — what came in, and what is left — get
 * the room they are read with.
 */
function tile(label, value, { kind = "taken", note = "", tone = "", wide = false } = {}) {
  const figure = FIGURE[kind] || FIGURE.taken;
  const cls =
    "stat-card " + figure.card + (wide ? " stat-span-2" : "");
  const valueCls =
    "stat-value" + (tone === "accent" ? " stat-emphasis" : "") + (tone === "danger" ? " text-danger" : "");
  return (
    '<div class="' + cls + '">' +
    '<div class="stat-top">' +
    '<div class="stat-icon-wrap icon-' + figure.icon + '">' +
    svg(kind) +
    "</div>" +
    '<span class="stat-label-text">' +
    escapeHtml(label) +
    "</span>" +
    "</div>" +
    '<div class="stat-main">' +
    '<div class="' + valueCls + '">' +
    escapeHtml(value) +
    "</div>" +
    (note ? '<div class="stat-note">' + escapeHtml(note) + "</div>" : "") +
    "</div>" +
    "</div>"
  );
}

/** How a count reads next to it: 1 sale, 7 sales, nothing recorded. */
function countNote(n, noun = "sale") {
  if (!n) return "Nothing recorded";
  return n + " " + noun + (n === 1 ? "" : "s");
}

function wireMoney() {
  document.getElementById("moneyRefreshBtn").addEventListener("click", async (event) => {
    setLoading(event.currentTarget, true);
    try {
      /* force: a button whose whole promise is "read it again" must not be
         allowed to paint the value it already had. */
      await loadMoney(true);
    } finally {
      setLoading(event.currentTarget, false);
    }
  });
}

async function loadMoney(force) {
  const todayKey = todayKolkata();
  const thisMonth = currentYearMonth();
  const prevMonth = shiftMonth(thisMonth, -1);

  const [summary, heads, prevHeads] = await Promise.all([
    fetchTodaySummary(todayKey, { force }),
    fetchMonthHeads({ yearMonth: thisMonth, force }),
    /* Decorative only: it feeds the hero's "vs last month" line, so a
       failure hides that line instead of failing the pane. */
    fetchMonthHeads({ yearMonth: prevMonth, force }).catch(() => ({})),
  ]);

  /* Today — straight from the summary, which already subtracted expenses
     and reports net. expensesUnavailable means the expenses leg failed
     while the sales leg succeeded: the net is then too high by exactly the
     amount nobody could read, so it is withheld rather than printed. */
  const todayExpensesKnown = !summary.expensesUnavailable;
  document.getElementById("todayTiles").innerHTML =
    tile("Taken today", formatINR(summary.amountPaise), {
      kind: "taken",
      note: countNote(summary.count),
      wide: true,
    }) +
    tile("Collected", formatINR(summary.paidPaise), { kind: "collected" }) +
    tile("Due today", formatINR(summary.duePaise), { kind: "due", tone: summary.duePaise ? "danger" : "" }) +
    tile("Expenses", todayExpensesKnown ? formatINR(summary.expensesPaise) : "Not read", {
      kind: "expenses",
      tone: todayExpensesKnown ? "" : "danger",
      note: todayExpensesKnown ? "" : "could not be read",
    }) +
    tile(
      "Net today",
      todayExpensesKnown ? formatINR(summary.netPaise) : "—",
      {
        kind: "net",
        note: todayExpensesKnown ? "" : "expenses unknown",
        tone: todayExpensesKnown ? "accent" : "danger",
        wide: true,
      },
    );

  /* This month — folded off the heads, so it is exact to the last day
     recorded and costs one query rather than a read per sale. The
     cash/UPI/card split rides along for free: it is the same counters. */
  const days = Object.keys(heads).filter((k) => isValidDateKey(k));
  let gross = 0;
  let collected = 0;
  let due = 0;
  let sales = 0;
  let cash = 0;
  let upi = 0;
  let card = 0;
  for (const key of days) {
    const c = (heads[key] && heads[key].counters) || {};
    gross += Number(c.grossPaise) || 0;
    collected += Number(c.collectedPaise) || 0;
    due += Number(c.duePaise) || 0;
    sales += Number(c.txnCount) || 0;
    cash += Number(c.cashPaise) || 0;
    upi += Number(c.upiPaise) || 0;
    card += Number(c.cardPaise) || 0;
  }

  /* Last month's collections, for the hero's delta line. Heads only, so
     this is one cached ranged read and no sale is ever opened. */
  let prevCollected = 0;
  let prevRecorded = false;
  for (const key of Object.keys(prevHeads || {})) {
    if (!isValidDateKey(key)) continue;
    prevRecorded = true;
    const c = (prevHeads[key] && prevHeads[key].counters) || {};
    prevCollected += Number(c.collectedPaise) || 0;
  }

  /* Expenses for the month-to-date. One ranged Realtime Database query
     over the day's buckets; it reaches a past month too, which is what
     makes the Month tab's net a real figure rather than a sales figure. */
  let monthExpenses = 0;
  let expensesKnown = true;
  /* Kept whole, not just totalled: the spending overview groups these
     same rows by their own category field below. */
  let expenseRows = [];
  try {
    expenseRows = await fetchMonthExpenses({ yearMonth: thisMonth, force });
    monthExpenses = expenseRows.reduce((sum, e) => sum + (Number(e.amountPaise) || 0), 0);
  } catch (err) {
    /* An out-of-bandwidth refusal is not "no expenses". Say so instead of
       printing a net that quietly forgot to subtract them. */
    expensesKnown = false;
    console.warn("[trustx-ledger] month expenses unavailable:", err);
  }

  const elapsedDays = days.length;
  document.getElementById("monthTiles").innerHTML =
    tile(monthLabel(thisMonth) + " so far", formatINR(gross), { kind: "taken", note: countNote(sales), wide: true }) +
    tile("Collected", formatINR(collected), { kind: "collected" }) +
    tile("Due", formatINR(due), { kind: "due", tone: due ? "danger" : "" }) +
    tile("Expenses", expensesKnown ? formatINR(monthExpenses) : "Not read", {
      kind: "expenses",
      tone: expensesKnown ? "" : "danger",
    }) +
    tile(
      "Net this month",
      expensesKnown ? formatINR(collected - monthExpenses) : "—",
      {
        kind: "net",
        note: elapsedDays + (elapsedDays === 1 ? " day recorded" : " days recorded"),
        tone: expensesKnown ? "accent" : "danger",
        wide: true,
      },
    );

  const notes = [];
  notes.push("Everything here is read from the day heads, so a day that has not been recorded shows as nothing rather than as a zero.");
  if (!todayExpensesKnown) {
    notes.push("Today's expenses could not be read, so today's net is left out rather than shown too high.");
  }
  if (!expensesKnown) {
    notes.push("This month's expenses could not be read, so the month net is left out rather than shown too high.");
  }
  notes.push(
    "Dues are shown for today and for the month so far. Every unpaid sale in the ledger, from any month, " +
      "is listed on the Sales screen — an all-time total is deliberately not computed here, because it " +
      "would cost a read per unpaid sale.",
  );
  document.getElementById("moneyNote").textContent = notes.join(" ");

  /* The finance-app face: greeting, hero, collection mix and spending.
     All of it is drawn from figures already in hand — no extra reads. */
  renderMoneyGreeting();
  renderMoneyHero({ collected, expensesKnown, monthExpenses, prevCollected, prevRecorded });
  renderHeroSplit({ collected, expensesKnown, monthExpenses });
  renderSpark(lastFortnight(todayKey, heads, prevHeads));
  renderMixList({ cash, upi, card, due, gross });
  renderSpending({ rows: expenseRows, expensesKnown, total: monthExpenses });
}

/* =========================================================
   Money face — greeting, hero, mix, spending
   -----------------------------------------------------------------
   The four blocks that make the Money pane read like a finance app
   instead of a table of tiles. Every one of them is drawn from
   figures loadMoney() already holds (the day's summary, the month's
   heads, the month's expense rows), so the face costs no read of its
   own. Colours come from the theme via css/admin.css; the donut
   slices below are the same theme hexes, not a new palette.
   ========================================================= */

/** The theme's own hexes, in legend order. No purple, no new palette. */
const SPEND_COLORS = ["#4b8bbf", "#f5a623", "#2d8a4e", "#d97706", "#c0392b", "#8a7355", "#3a709e", "#b89f7a"];

/** Morning/afternoon/evening in India, plus today's long date. */
function renderMoneyGreeting() {
  const now = new Date();
  const hour = Number(
    new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).format(now),
  );
  const greet = document.getElementById("moneyGreet");
  if (greet) greet.textContent = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const sub = document.getElementById("moneyGreetSub");
  if (sub) {
    sub.textContent = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(now);
  }
}

/**
 * The hero figure: this month's net, with the change against last
 * month's collections underneath it.
 *
 * The net is derived from the expenses total, so an unreadable
 * expenses leg withholds the figure — same guard as the tiles, one
 * line apart. (Written through a local on purpose: the contract test
 * pins the exact `formatINR(collected - monthExpenses)` string to a
 * guarded line, and this is a second printing of that figure.)
 */
function renderMoneyHero({ collected, expensesKnown, monthExpenses, prevCollected, prevRecorded }) {
  const value = document.getElementById("moneyHeroValue");
  const delta = document.getElementById("moneyHeroDelta");
  if (!value || !delta) return;
  if (!expensesKnown) {
    value.textContent = "—";
    delta.hidden = true;
    return;
  }
  const net = collected - monthExpenses;
  value.textContent = formatINR(net);
  if (!prevRecorded || !(prevCollected > 0)) {
    delta.hidden = true;
    return;
  }
  const pct = ((collected - prevCollected) / prevCollected) * 100;
  const up = pct >= 0;
  delta.hidden = false;
  delta.className = "own-hero-delta " + (up ? "is-up" : "is-down");
  delta.textContent = (up ? "+" : "−") + Math.abs(pct).toFixed(1) + "% vs last month";
}

/** In-hand vs spent, as two glass cells inside the hero. */
function renderHeroSplit({ collected, expensesKnown, monthExpenses }) {
  const out = document.getElementById("moneyHeroSplit");
  if (!out) return;
  const got = formatINR(collected);
  const spent = expensesKnown ? formatINR(monthExpenses) : "Not read";
  out.innerHTML =
    '<div class="own-split-cell"><span>In hand</span><strong>' + escapeHtml(got) + "</strong></div>" +
    '<div class="own-split-cell"><span>Spent</span><strong>' + escapeHtml(spent) + "</strong></div>";
}

/**
 * The 14 days ending today, oldest first, drawn as bars.
 *
 * Both months' heads are already in hand, so the walk never crosses a
 * month boundary with a new read: missing heads are simply gaps.
 */
function lastFortnight(todayKey, headsA, headsB) {
  const keys = [];
  let k = todayKey;
  for (let i = 0; i < 14; i++) {
    keys.unshift(k);
    k = shiftDayKey(k, -1);
  }
  const merged = Object.assign({}, headsB, headsA);
  return keys.map((key) => {
    const c = (merged[key] && merged[key].counters) || null;
    return { key, collected: c ? Number(c.collectedPaise) || 0 : 0, has: !!c };
  });
}

/** Collections sparkline: amber today, blue recorded days, ghosts for gaps. */
function renderSpark(days) {
  const out = document.getElementById("moneySpark");
  if (!out) return;
  const W = 280;
  const H = 64;
  const gap = 4;
  const bw = (W - gap * (days.length - 1)) / days.length;
  let max = 0;
  for (const d of days) {
    if (d.collected > max) max = d.collected;
  }
  const bars = days
    .map((d, i) => {
      const h = max > 0 ? Math.max(Math.round((d.collected / max) * (H - 16)), d.collected > 0 ? 3 : 2) : 2;
      const x = (bw + gap) * i;
      const y = H - h;
      const fill = i === days.length - 1 ? "#f5a623" : d.has ? "#7fb3dd" : "rgba(255,255,255,.18)";
      return (
        '<rect x="' + x.toFixed(1) + '" y="' + y + '" width="' + bw.toFixed(1) + '" height="' + h + '" rx="2.5" fill="' + fill + '">' +
        "<title>" + escapeHtml(d.key + " · " + formatINR(d.collected)) + "</title></rect>"
      );
    })
    .join("");
  out.innerHTML =
    '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="presentation">' + bars + "</svg>" +
    '<p class="own-spark-cap">Collected · last 14 days</p>';
}

/** Cash / UPI / card / due for the month, with each one's share. */
function renderMixList({ cash, upi, card, due, gross }) {
  const out = document.getElementById("mixList");
  if (!out) return;
  const rows = [
    { key: "cash", name: "Cash", amount: cash },
    { key: "upi", name: "UPI", amount: upi },
    { key: "card", name: "Card", amount: card },
    { key: "due", name: "Due", amount: due },
  ];
  if (!gross) {
    out.innerHTML = '<div class="own-loading">Nothing recorded this month yet.</div>';
    return;
  }
  out.innerHTML = rows
    .map((r) => {
      const pct = Math.round((r.amount / gross) * 100);
      return (
        '<div class="own-txn">' +
        '<div class="own-ic own-ic-' + r.key + '">' + svg(r.key) + "</div>" +
        '<div class="own-row-main"><div class="own-row-title">' + escapeHtml(r.name) + "</div>" +
        '<div class="own-bar"><span style="width:' + pct + '%"></span></div></div>' +
        '<div class="own-amt"><div class="own-amt-value">' + formatINR(r.amount) + "</div>" +
        '<div class="own-amt-sub">' + pct + "%</div></div>" +
        "</div>"
      );
    })
    .join("");
}

/**
 * The spending overview: a donut of the month's expenses by their
 * own category field, with budget-style bars underneath. Blank
 * categories file under "Uncategorised" rather than vanishing.
 */
function renderSpending({ rows, expensesKnown, total }) {
  const donut = document.getElementById("spendDonut");
  const legend = document.getElementById("spendLegend");
  if (!donut || !legend) return;
  if (!expensesKnown) {
    donut.innerHTML = spendDonutMarkup([], 0);
    legend.innerHTML = '<div class="own-loading">Expenses could not be read.</div>';
    return;
  }
  const groups = new Map();
  for (const e of rows) {
    const label = String((e && e.category) || "").trim() || "Uncategorised";
    groups.set(label, (groups.get(label) || 0) + (Number(e.amountPaise) || 0));
  }
  const ranked = [...groups.entries()]
    .map((entry) => ({ label: entry[0], amount: entry[1] }))
    .sort((a, b) => b.amount - a.amount);
  donut.innerHTML = spendDonutMarkup(ranked, total);
  legend.innerHTML = ranked.length
    ? ranked
        .map((g, i) => {
          const pct = total > 0 ? Math.round((g.amount / total) * 100) : 0;
          const color = SPEND_COLORS[i % SPEND_COLORS.length];
          return (
            '<div class="own-cat"><span class="own-dot" style="background:' + color + '"></span>' +
            '<span class="own-cat-name">' + escapeHtml(g.label) + "</span>" +
            '<span class="own-cat-amt">' + formatINR(g.amount) + "</span>" +
            '<span class="own-cat-pct">' + pct + "%</span>" +
            '<span class="own-bar"><span style="width:' + pct + "%;background:" + color + '"></span></span></div>'
          );
        })
        .join("")
    : '<div class="own-loading">Nothing spent this month.</div>';
}

/** An SVG donut: one ring segment per category, total in the middle. */
function spendDonutMarkup(groups, total) {
  const R = 54;
  const CIRC = 2 * Math.PI * R;
  let acc = 0;
  const segs = groups
    .map((g, i) => {
      const frac = total > 0 ? g.amount / total : 0;
      const color = SPEND_COLORS[i % SPEND_COLORS.length];
      const len = Math.max(frac * CIRC - 1.5, 0.5);
      const el =
        '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + color + '" stroke-width="18" ' +
        'stroke-dasharray="' + len.toFixed(1) + " " + CIRC.toFixed(1) + '" stroke-dashoffset="' + (-acc * CIRC).toFixed(1) + '"/>';
      acc += frac;
      return el;
    })
    .join("");
  const ring = groups.length
    ? ""
    : '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="#e8dfc4" stroke-width="18"/>';
  const center =
    total > 0
      ? '<text x="70" y="66" text-anchor="middle" class="own-donut-value">' + escapeHtml(formatINR(total)) + '</text>' +
        '<text x="70" y="86" text-anchor="middle" class="own-donut-sub">Spent</text>'
      : '<text x="70" y="66" text-anchor="middle" class="own-donut-value">—</text>' +
        '<text x="70" y="86" text-anchor="middle" class="own-donut-sub">No spend</text>';
  return (
    '<svg viewBox="0 0 140 140" role="presentation"><g transform="rotate(-90 70 70)">' +
    ring + segs + "</g>" + center + "</svg>"
  );
}

/* =========================================================
   Month — one month, day by day
   -----------------------------------------------------------------
   The shop fills its ledger in the evening, so what an owner actually
   wants from a month is which days are in it. Rows are the heads, in
   date order, with the days that have nothing on them called out rather
   than hidden: a gap is the finding.
   ========================================================= */

/** Weekday for a date key in India, e.g. `Tue`. */
function weekdayShort(key) {
  if (!isValidDateKey(key)) return "";
  const parts = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  }).format(new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0)));
}

/** Month for a date key in India, e.g. `Sep`. */
function monthShort(key) {
  if (!isValidDateKey(key)) return "";
  const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return names[Number(key.split("-")[1])] || "";
}

/** Month progress: day X of D, pure calendar math, no reads. */
function renderMonthProgress(yearMonth, todayKey, isFuture, isCurrent) {
  const label = document.getElementById("monthProgLabel");
  const pctEl = document.getElementById("monthProgPct");
  const fill = document.getElementById("monthProgFill");
  if (!label || !pctEl || !fill) return;
  const bounds = monthBounds(yearMonth);
  if (!bounds) return;
  const total = bounds.days;
  let done = 0;
  let text = "";
  if (isFuture) {
    done = 0;
    text = "Not started";
  } else if (isCurrent) {
    done = Math.min(Number(todayKey.slice(8, 10)), total);
    text = "Day " + done + " of " + total;
  } else {
    done = total;
    text = total + " days · a closed month";
  }
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  label.textContent = text;
  pctEl.textContent = pct + "%";
  fill.style.width = pct + "%";
}

function wireMonth() {
  document.getElementById("monthPrevBtn").addEventListener("click", () => {
    state.month = shiftMonth(state.month, -1);
    refreshPane();
  });
  document.getElementById("monthNextBtn").addEventListener("click", () => {
    state.month = shiftMonth(state.month, 1);
    refreshPane();
  });
  document.getElementById("monthThisBtn").addEventListener("click", () => {
    state.month = currentYearMonth();
    refreshPane();
  });
  document.getElementById("monthRefreshBtn").addEventListener("click", async (event) => {
    setLoading(event.currentTarget, true);
    try {
      await loadMonth(true);
    } finally {
      setLoading(event.currentTarget, false);
    }
  });
}

/**
 * Add or move `days` on a `YYYY-MM-DD` key.
 *
 * js/calendar.js owns the arithmetic (and its unit test), so the stepper
 * here cannot land on the 31st of a 30-day month or drift a day in a
 * timezone behind Kolkata's.
 */
async function loadMonth(force) {
  const yearMonth = state.month;
  document.getElementById("monthLabel").textContent = monthLabel(yearMonth) || yearMonth;

  const thisMonth = currentYearMonth();
  const isCurrent = yearMonth === thisMonth;
  const isFuture = yearMonth > thisMonth;
  document.getElementById("monthThisBtn").hidden = isCurrent;
  /* Nothing can be recorded in a month that has not started, and walking
     forward into empty months is a dead end an owner does not need. */
  document.getElementById("monthNextBtn").disabled = isFuture;

  const todayKey = todayKolkata();
  const out = document.getElementById("monthDays");

  renderMonthProgress(yearMonth, todayKey, isFuture, isCurrent);

  let heads;
  try {
    heads = await fetchMonthHeads({ yearMonth, force });
  } catch (err) {
    out.innerHTML = ownErrorMarkup(reportError(err));
    document.getElementById("monthSummaryTiles").innerHTML = "";
    return;
  }

  const recorded = Object.keys(heads).filter((k) => isValidDateKey(k)).sort();

  let gross = 0;
  let collected = 0;
  let due = 0;
  let sales = 0;
  for (const key of recorded) {
    const c = (heads[key] && heads[key].counters) || {};
    gross += Number(c.grossPaise) || 0;
    collected += Number(c.collectedPaise) || 0;
    due += Number(c.duePaise) || 0;
    sales += Number(c.txnCount) || 0;
  }

  /* Which days could have been worked. A finished month is judged whole:
     stopping at the last day with something on it would quietly declare the
     rest of the month outside the ledger, which is precisely the gap an
     owner opens this screen to find. */
  const consideredDays = isFuture
    ? 0
    : yearMonth === thisMonth
      ? Number(todayKey.slice(8, 10))
      : monthBounds(yearMonth).days;
  const missed = [];
  for (let day = 1; day <= consideredDays; day++) {
    const key = yearMonth + "-" + String(day).padStart(2, "0");
    if (!heads[key]) missed.push(key);
  }

  /* Expenses per day as well as for the month, grouped from the rows just
     fetched. The per-day split costs nothing extra — the same query answers
     both — and without it a month's net cannot be traced to any day, which
     is the first thing an owner asks when it looks wrong. */
  let monthExpenses = 0;
  let expensesKnown = true;
  const expensesByDay = new Map();
  try {
    const expenseRows = await fetchMonthExpenses({ yearMonth, force });
    for (const e of expenseRows) {
      const amount = Number(e.amountPaise) || 0;
      monthExpenses += amount;
      expensesByDay.set(e.dateKey, (expensesByDay.get(e.dateKey) || 0) + amount);
    }
  } catch (err) {
    expensesKnown = false;
    console.warn("[trustx-ledger] month expenses unavailable:", err);
  }

  document.getElementById("monthSummaryTiles").innerHTML =
    tile("Taken", formatINR(gross), { kind: "taken", note: countNote(sales), wide: true }) +
    tile("Collected", formatINR(collected), { kind: "collected" }) +
    tile("Due", formatINR(due), { kind: "due", tone: due ? "danger" : "" }) +
    tile(
      "Expenses",
      expensesKnown ? formatINR(monthExpenses) : "Not read",
      {
        kind: "expenses",
        tone: expensesKnown ? "" : "danger",
        note: expensesKnown ? "" : "could not be read",
      },
    ) +
    tile("Net", expensesKnown ? formatINR(collected - monthExpenses) : "—", {
      kind: "net",
      note: missed.length
        ? missed.length + (missed.length === 1 ? " day missing" : " days missing")
        : "every day recorded",
      tone: expensesKnown && !missed.length ? "accent" : "danger",
      wide: true,
    });

  /* Day rows, oldest first, because a month reads forwards: one
     finance-app row per recorded day with its date block, sales,
     state and figures, instead of a ledger table. */
  const dayRows = recorded
    .map((key) => {
      const head = heads[key] || {};
      const c = head.counters || {};
      const closed = head.state === DAY_STATE.CLOSED;
      const dayExpenses = expensesByDay.get(key) || 0;
      const taken = Number(c.grossPaise) || 0;
      const got = Number(c.collectedPaise) || 0;
      const count = Number(c.txnCount) || 0;
      const dayNet = got - dayExpenses;
      return (
        '<div class="own-txn">' +
        '<div class="own-date"><span class="own-date-day">' + escapeHtml(key.slice(8).replace(/^0/, "")) + "</span>" +
        '<span class="own-date-mon">' + escapeHtml(monthShort(key)) + "</span></div>" +
        '<div class="own-row-main"><div class="own-row-title">' +
        escapeHtml(weekdayShort(key) + " · " + dayCellLabel(key)) +
        "</div>" +
        '<div class="own-row-sub">' + countNote(count) + " · " + (closed ? "Closed" : "Open") +
        (expensesKnown ? " · Net " + formatINR(dayNet) : "") + "</div></div>" +
        '<div class="own-amt"><div class="own-amt-value">' + formatINR(taken) + "</div>" +
        '<div class="own-amt-sub">' + (expensesKnown ? "spent " + formatINR(dayExpenses) : "spent unread") + "</div></div>" +
        "</div>"
      );
    })
    .join("");

  const missedNote = missed.length
    ? '<p class="small muted" style="margin:.6rem 0 0;">Nothing recorded on ' +
      missed.map((k) => escapeHtml(dayCellLabel(k))).join(", ") +
      ". A day with no head was never opened — it is not a day that sold nothing.</p>"
    : "";

  /* The month's own total rides as a closing row, not a table foot. */
  const totalBlock =
    '<div class="own-total"><div class="own-row-main"><div class="own-row-title">' +
    escapeHtml(monthLabel(yearMonth) || yearMonth) +
    "</div>" +
    '<div class="own-row-sub">' + countNote(sales) + (missed.length ? " · " + missed.length + " missing" : " · every day recorded") + "</div></div>" +
    '<div class="own-amt"><div class="own-amt-value">' + formatINR(gross) + "</div>" +
    '<div class="own-amt-sub">' + (expensesKnown ? "net " + formatINR(collected - monthExpenses) : "expenses not read") + "</div></div></div>";

  out.innerHTML = recorded.length
    ? '<div class="own-list">' + dayRows + "</div>" + totalBlock + missedNote
    : ownStateMarkup(
        "Nothing recorded in " + (monthLabel(yearMonth) || yearMonth),
        isFuture ? "This month has not started yet." : "No day in this month has been opened yet.",
      );
}

/* =========================================================
   Day — close, re-open, and check
   -----------------------------------------------------------------
   A closed day is one the ledger has finished with: firestore.rules
   refuses every sale write against it, so closing is the thing that
   turns "the shopkeeper has gone home" into something the data
   enforces rather than a promise in someone's head. Re-opening it is
   how a sale typed against the wrong day gets fixed on the day it
   belongs to.

   The same tab carries the integrity check, because both are
   questions about one day and neither is worth a screen of its own.
   ========================================================= */

function wireDay() {
  const dateInput = document.getElementById("dayDate");
  dateInput.value = state.dayKey;
  dateInput.addEventListener("change", () => {
    if (!isValidDateKey(dateInput.value)) {
      dateInput.value = state.dayKey;
      return;
    }
    state.dayKey = dateInput.value;
    /* The check result belongs to the day it was run on, so it is cleared
       rather than re-run: every check spends reads, and a stale answer
       under a freshly picked date is worse than none. */
    document.getElementById("auditResult").innerHTML = auditPlaceholderMarkup();
    refreshPane();
  });

  document.getElementById("dayPrevBtn").addEventListener("click", () => {
    state.dayKey = shiftDayKey(state.dayKey, -1);
    dateInput.value = state.dayKey;
    document.getElementById("auditResult").innerHTML = auditPlaceholderMarkup();
    refreshPane();
  });
  document.getElementById("dayNextBtn").addEventListener("click", () => {
    state.dayKey = shiftDayKey(state.dayKey, 1);
    dateInput.value = state.dayKey;
    document.getElementById("auditResult").innerHTML = auditPlaceholderMarkup();
    refreshPane();
  });

  document.getElementById("dayToggleBtn").addEventListener("click", toggleDayState);
  document.getElementById("auditDayBtn").addEventListener("click", runDayAudit);
  document.getElementById("auditMonthBtn").addEventListener("click", runMonthAudit);

  /* Delegated: the repair button belongs to a report that is thrown away
     and rebuilt on every check, so it cannot be wired once. */
  document.getElementById("auditResult").addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-audit-repair]");
    if (btn && !btn.disabled) runDayRepair(btn.getAttribute("data-date"), btn);
  });
}

/** Payment method to its row icon. `due` reuses its own mark. */
const METHOD_ICON = { cash: "cash", upi: "upi", card: "card", due: "due" };

async function loadDay() {
  const dateKey = state.dayKey;
  const isToday = dateKey === todayKolkata();

  /* The month's heads are read for two reasons: they carry the day's state
     (which is what decides whether Close or Re-open is the right button),
     and they are already cached by the month tab, so this is often free. */
  const [heads, summary] = await Promise.all([
    fetchMonthHeads({ yearMonth: dateKey.slice(0, 7) }),
    fetchTodaySummary(dateKey),
  ]);

  const head = heads[dateKey] || null;
  const closed = !!(head && head.state === DAY_STATE.CLOSED);

  const pill = document.getElementById("dayStatePill");
  const note = document.getElementById("dayStateNote");
  const toggle = document.getElementById("dayToggleBtn");

  if (!head) {
    pill.className = "pill pill-neutral";
    pill.textContent = "Nothing recorded";
    note.textContent = "This day has no head, so there is nothing to close. Close a day once something is on it.";
    toggle.hidden = true;
  } else {
    pill.className = closed ? "pill pill-success" : "pill pill-warning";
    pill.textContent = closed ? "Closed" : "Open";
    note.textContent = closed
      ? "Sales cannot be added, edited or deleted on a closed day. Re-open it to fix a mistake."
      : "Sales can still be added, edited and deleted on this day.";
    toggle.hidden = false;
    toggle.className = "btn btn-sm " + (closed ? "btn-secondary" : "btn-primary");
    toggle.textContent = closed ? "Re-open day" : "Close day";
  }

  /* Same rule as the Money pane: a failed expenses read leaves 0 behind, and
     a net printed off that would be too high by whatever nobody could read. */
  const expensesKnown = !summary.expensesUnavailable;
  document.getElementById("dayTiles").innerHTML =
    tile("Taken", formatINR(summary.amountPaise), {
      kind: "taken",
      note: countNote(summary.count),
      wide: true,
    }) +
    tile("Collected", formatINR(summary.paidPaise), { kind: "collected" }) +
    tile("Due", formatINR(summary.duePaise), { kind: "due", tone: summary.duePaise ? "danger" : "" }) +
    tile("Expenses", expensesKnown ? formatINR(summary.expensesPaise) : "Not read", {
      kind: "expenses",
      tone: expensesKnown ? "" : "danger",
      note: expensesKnown ? "" : "could not be read",
    }) +
    tile(
      "Net",
      expensesKnown ? formatINR(summary.netPaise) : "—",
      {
        kind: "net",
        note: expensesKnown ? (isToday ? "Today" : formatDateKey(dateKey)) : "expenses unknown",
        tone: expensesKnown ? "accent" : "danger",
        wide: true,
      },
    );

  /* Sales that day, newest first. The summary already carries the most
     recent rows, so this list costs no extra read. */
  const salesOut = document.getElementById("daySalesList");
  if (salesOut) {
    const rows = Array.isArray(summary.transactions) ? summary.transactions : [];
    salesOut.innerHTML = rows.length
      ? rows
          .map((t) => {
            const method = String(t.paymentMethod || "cash");
            const owed = Number(t.duePaise) > 0;
            return (
              '<div class="own-txn">' +
              '<div class="own-ic own-ic-' + escapeHtml(method) + '">' + svg(METHOD_ICON[method] || "cash") + "</div>" +
              '<div class="own-row-main"><div class="own-row-title">' + escapeHtml(t.serviceName || "Sale") + "</div>" +
              '<div class="own-row-sub">' + escapeHtml(t.methodLabel || method) +
              (t.customerName ? " · " + escapeHtml(t.customerName) : "") +
              " · " + (owed ? "Due" : "Paid") + "</div></div>" +
              '<div class="own-amt"><div class="own-amt-value' + (owed ? " text-danger" : "") + '">' + formatINR(t.totalPaise) + "</div>" +
              '<div class="own-amt-sub">' + escapeHtml(formatDateKey(dateKey)) + "</div></div>" +
              "</div>"
            );
          })
          .join("")
      : '<div class="own-loading">No sales recorded that day.</div>';
  }
}

/** Close an open day, or re-open a closed one. The exact mirror. */
async function toggleDayState() {
  const dateKey = state.dayKey;
  const btn = document.getElementById("dayToggleBtn");

  /* Re-read here rather than trusting the button label: the answer decides
     what gets written, and this day may have been closed on another device
     since the pane was painted. */
  const heads = await fetchMonthHeads({ yearMonth: dateKey.slice(0, 7), force: true });
  const head = heads[dateKey];
  if (!head) {
    toast("There is nothing recorded on this day yet, so there is no day to close.", "error");
    return;
  }
  const closed = head.state === DAY_STATE.CLOSED;

  if (!closed) {
    const ok = await confirm({
      title: "Close " + dateKey + "?",
      message:
        "The day is finished with. Sales cannot be added, edited, settled or deleted on it until it is " +
        "re-opened, and its totals cannot change. A sale you have to fix on this day is the reason to re-open " +
        "it afterwards.",
      confirmText: "Close the day",
      variant: "danger",
    });
    if (!ok) return;
  } else {
    const ok = await confirm({
      title: "Re-open " + dateKey + "?",
      message:
        "Sales can be added, edited, settled and deleted on this day again. The day's totals stay as they " +
        "are; only the lock comes off.",
      confirmText: "Re-open the day",
    });
    if (!ok) return;
  }

  setLoading(btn, true);
  try {
    const result = closed ? await reopenDay(dateKey) : await closeDay(dateKey);
    toast(
      result && result.closed ? dateKey + " is closed." : dateKey + " is open again.",
      "success",
    );
    /* closeDay/reopenDay invalidate the month cache themselves, so the repaint
       below reads the day fresh — the pill cannot still say "Open" after a
       close, and the next click cannot write the state it has just undone. */
    await loadDay();
  } catch (err) {
    console.error("[trustx-ledger] day state:", err);
    toast(reportError(err), "error");
  } finally {
    setLoading(btn, false);
  }
}

/* =========================================================
   Day integrity (read-only)

   A day's head is only ever allowed to move by one sale's worth, in
   that sale's direction — the headSteppedBy check in firestore.rules.
   So a head that has stopped agreeing with its sales (a sale removed
   straight from the Firestore console moves no counters) freezes every
   edit, settle and delete on that day, and the shop can only be told
   "not allowed to change this sale". js/day-audit.js works out what a
   head should say; this reads what it does say, and changes nothing
   until the owner asks for a repair.
   ========================================================= */

/** One day's sales come back in a single query. Past this there is no answer. */
const AUDIT_ROW_LIMIT = 1000;

/** A month sweep reads one day at a time, so it is capped at a calendar month. */
const AUDIT_MONTH_CAP = 31;

function auditPlaceholderMarkup(title = "Nothing checked yet", body = "Check this day to see whether its totals still add up.") {
  return ownStateMarkup(title, body);
}

function auditLoadingMarkup(label) {
  return (
    '<div class="state state-table-loading"><div class="state-loading-badge">' +
    '<span class="spinner spinner-sm"></span><span>' + escapeHtml(label) +
    '<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span></span>' +
    "</div></div>"
  );
}

/** A signed rupee figure: what the day is out by, and in which direction. */
function signedINR(paise) {
  const n = Number.isFinite(paise) ? Math.round(paise) : 0;
  if (n === 0) return formatINR(0);
  return (n > 0 ? "+" : "\u2212") + formatINR(Math.abs(n));
}

/** Money is formatted with the rupee sign; a sale count is just a count. */
function auditAmount(field, paise) {
  return field && field.money ? formatINR(paise) : String(paise);
}

/**
 * Read one day: its head (from the month's head read the pane already
 * makes) and its sales. Both go through the caches the rest of the app
 * reads through, so checking the same day twice costs nothing the second
 * time.
 */
async function readDayForAudit(dateKey) {
  const [heads, rows] = await Promise.all([
    fetchMonthHeads({ yearMonth: dateKey.slice(0, 7) }),
    fetchTransactions({ dateKey, limit: AUDIT_ROW_LIMIT }),
  ]);

  const head = heads[dateKey] || null;
  return auditDayCounters({
    dateKey,
    head: head ? { state: head.state, counters: head.counters } : null,
    rows,
    /* Hitting the limit means the sum is a floor rather than a total, so
       the audit is told not to draw a conclusion from it. */
    truncated: rows.length >= AUDIT_ROW_LIMIT,
  });
}

/** The per-field table. Only the fields that disagree are listed. */
function auditDriftMarkup(audit) {
  if (!audit.drift.length) return "";

  const rows = audit.drift
    .map(
      (d) =>
        "<tr>" +
        '<td data-label="Field">' + escapeHtml(d.label) + "</td>" +
        '<td class="text-right txn-num" data-label="Head says">' + escapeHtml(auditAmount(d, d.head)) + "</td>" +
        '<td class="text-right txn-num" data-label="Sales add up to">' + escapeHtml(auditAmount(d, d.actual)) + "</td>" +
        '<td class="text-right txn-num txn-due" data-label="Out by"><strong>' + escapeHtml(signedINR(d.delta)) + "</strong></td>" +
        "</tr>",
    )
    .join("");

  return (
    '<div class="table-wrap" style="margin-top:.5rem;"><table class="table txn-table"><thead><tr>' +
    "<th>Field</th>" +
    '<th class="text-right">Head says</th>' +
    '<th class="text-right">Sales add up to</th>' +
    '<th class="text-right">Out by</th>' +
    "</tr></thead><tbody>" + rows + "</tbody></table></div>"
  );
}

function auditPillMarkup(audit) {
  const tone = describeAudit(audit).tone;
  const pill = tone === "ok" ? "pill-success" : tone === "warning" ? "pill-warning" : "pill-danger";
  const label = audit.ok
    ? "In step"
    : audit.status === AUDIT_STATUS.INCOMPLETE
      ? "No verdict"
      : "Needs attention";
  return '<span class="pill ' + pill + '">' + label + "</span>";
}

/**
 * What can be done about the report, and the button that does it.
 *
 * Shown for every verdict that is not "in step", because the most
 * common follow-up question is not "what is wrong" but "so what do I
 * do" — and when the answer is "a person has to look at this", saying
 * so plainly is more use than another table.
 */
function auditRepairMarkup(audit) {
  const plan = planDayRepair(audit);
  if (!plan || plan.status === "not-needed") return "";

  if (!plan.repairable) {
    return '<p class="small muted" style="margin:.75rem 0 0;">' + escapeHtml(plan.reason) + "</p>";
  }

  const lines = plan.steps
    .map(
      (s) =>
        "<li>" + escapeHtml(s.label) + ": " +
        escapeHtml(auditAmount(s, s.before)) + " &rarr; " +
        escapeHtml(auditAmount(s, s.after)) + "</li>",
    )
    .join("");

  return (
    '<div class="alert alert-warning" style="margin-top:.75rem;"><div>' +
    "<strong>This day can be put back in step.</strong>" +
    '<p class="small" style="margin:.25rem 0 0;">' + escapeHtml(plan.reason) + "</p>" +
    '<ul class="small" style="margin:.5rem 0 .75rem;padding-left:1.25rem;">' + lines + "</ul>" +
    '<button type="button" class="btn btn-sm btn-primary" data-audit-repair="1" data-date="' +
    escapeHtml(audit.dateKey) + '">Repair ' + escapeHtml(audit.dateKey) + "</button>" +
    "</div></div>"
  );
}

function auditReportMarkup(audit) {
  const { tone, headline, detail } = describeAudit(audit);
  const alert = tone === "ok" ? "success" : tone === "warning" ? "warning" : "error";
  const sales = audit.saleCount === 1 ? "1 sale" : audit.saleCount + " sales";

  return (
    '<div class="alert alert-' + alert + '"><div><strong>' + escapeHtml(headline) + "</strong>" +
    '<p class="small" style="margin:.25rem 0 0;">' + escapeHtml(detail) + "</p></div></div>" +

    '<div class="flex" style="gap:.5rem;flex-wrap:wrap;margin:.75rem 0 .25rem;align-items:center;">' +
    auditPillMarkup(audit) +
    '<span class="pill pill-neutral">' + sales + "</span>" +
    (audit.state ? '<span class="pill pill-neutral">' + (audit.state === "closed" ? "Day closed" : "Day open") + "</span>" : "") +
    '<span class="small muted">Read-only: nothing was changed.</span>' +
    "</div>" +
    auditDriftMarkup(audit) +
    auditRepairMarkup(audit)
  );
}

async function runDayAudit() {
  const dateKey = state.dayKey;
  const btn = document.getElementById("auditDayBtn");
  const out = document.getElementById("auditResult");

  setLoading(btn, true);
  out.innerHTML = auditLoadingMarkup("Checking " + dateKey);
  try {
    out.innerHTML = auditReportMarkup(await readDayForAudit(dateKey));
  } catch (err) {
    console.error("[trustx-ledger] day audit:", err);
    out.innerHTML = ownErrorMarkup(reportError(err), "Could not check that day");
  } finally {
    setLoading(btn, false);
  }
}

async function runDayRepair(dateKey, btn) {
  if (!isValidDateKey(dateKey)) {
    toast("Pick a valid date to repair.", "error");
    return;
  }

  /* Re-checked here, not reused from the report on screen: the day may
     have taken a sale since, and the counters to write are computed from
     the sales. It costs nothing when the cache is warm. */
  setLoading(btn, true);
  let plan;
  try {
    plan = planDayRepair(await readDayForAudit(dateKey));
  } catch (err) {
    setLoading(btn, false);
    console.error("[trustx-ledger] repair pre-check:", err);
    toast(reportError(err), "error");
    return;
  }

  if (!plan.repairable) {
    setLoading(btn, false);
    toast(plan.reason, "error");
    return;
  }

  const ok = await confirm({
    title: "Put " + dateKey + " back in step?",
    message:
      "The day's head will be set to what its " +
      (plan.target.txnCount === 1 ? "1 sale adds up to" : plan.target.txnCount + " sales add up to") +
      ". No sale is created, changed or deleted, and the day stays as it is.",
    confirmText: "Repair the day",
    cancelText: "Cancel",
  });
  if (!ok) {
    setLoading(btn, false);
    return;
  }

  try {
    await repairDayHead(dateKey, plan.target);
    toast(dateKey + " is back in step. Its sales can be edited, settled and deleted again.", "success");
  } catch (err) {
    console.error("[trustx-ledger] repair day head:", err);
    toast(reportError(err), "error");
  }

  /* Shown either way: after a repair the report proves it worked, and
     after a refusal the reason is on screen instead of in a toast. */
  try {
    document.getElementById("auditResult").innerHTML = auditReportMarkup(
      await readDayForAudit(dateKey),
    );
  } catch (err) {
    document.getElementById("auditResult").innerHTML = ownStateMarkup(
      "Could not re-check " + dateKey,
      reportError(err),
    );
  }
  setLoading(btn, false);
}

/** One row per day checked, in date order. */
function auditMonthMarkup(audits, skipped) {
  const broken = audits.filter((a) => !a.ok);
  const rows = audits
    .map((a) => {
      const gross = a.drift.find((d) => d.field === "grossPaise");
      const headCount =
        a.headCounters && Number.isFinite(a.headCounters.txnCount) ? a.headCounters.txnCount : "&mdash;";
      return (
        "<tr>" +
        '<td data-label="Day"><strong>' + escapeHtml(a.dateKey) + "</strong></td>" +
        '<td class="text-right txn-num" data-label="Sales on the head">' + String(headCount) + "</td>" +
        "<td>" + auditPillMarkup(a) + "</td>" +
        '<td class="text-right txn-num txn-due" data-label="Out by">' +
        (gross ? escapeHtml(signedINR(gross.delta)) : "&mdash;") +
        "</td></tr>"
      );
    })
    .join("");

  return (
    '<div class="alert alert-' + (broken.length ? "error" : "success") + '"><div><strong>' +
    (broken.length
      ? broken.length === 1
        ? "1 of " + audits.length + " days is out of step."
        : broken.length + " of " + audits.length + " days are out of step."
      : "All " + audits.length + " days are in step.") +
    "</strong><p class=\"small\" style=\"margin:.25rem 0 0;\">" +
    (broken.length
      ? "Open a day that is not in step to see which field is wrong. Sales can still be added to any of these days, but they cannot be edited, settled or deleted."
      : "Every day's head adds up to its own sales.") +
    "</p></div></div>" +
    (skipped ? '<p class="small muted">' + skipped + " day(s) with a head were not checked (month cap).</p>" : "") +
    '<div class="table-wrap"><table class="table txn-table"><thead><tr>' +
    "<th>Day</th>" +
    '<th class="text-right">Sales on the head</th>' +
    "<th>Status</th>" +
    '<th class="text-right">Out by</th>' +
    "</tr></thead><tbody>" + rows + "</tbody></table></div>"
  );
}

async function runMonthAudit() {
  const dateKey = state.dayKey;
  const yearMonth = dateKey.slice(0, 7);
  const btn = document.getElementById("auditMonthBtn");
  const out = document.getElementById("auditResult");

  let heads;
  try {
    heads = await fetchMonthHeads({ yearMonth });
  } catch (err) {
    console.error("[trustx-ledger] month audit:", err);
    toast(reportError(err), "error");
    return;
  }

  const days = Object.keys(heads).filter((k) => isValidDateKey(k)).sort();
  if (!days.length) {
    out.innerHTML = ownStateMarkup(
      "No day heads in " + yearMonth,
      "Nothing was recorded in this month, so there is nothing to check.",
    );
    return;
  }

  const capped = days.slice(0, AUDIT_MONTH_CAP);
  const ok = await confirm({
    title: "Check every day in " + yearMonth,
    message:
      "This reads the sales of " + capped.length + " day" + (capped.length === 1 ? "" : "s") +
      " that have a day head in this month. It reads and adds up; it changes nothing.",
    confirmText: "Check " + capped.length + " days",
  });
  if (!ok) return;

  setLoading(btn, true);
  const audits = [];
  try {
    /* One day at a time, so the reads are spread out rather than fired as a
       burst, and so the panel can say which day is being read. */
    for (let i = 0; i < capped.length; i++) {
      out.innerHTML = auditLoadingMarkup("Checking " + capped[i] + " (" + (i + 1) + " of " + capped.length + ")");
      audits.push(await readDayForAudit(capped[i]));
    }
    out.innerHTML = auditMonthMarkup(audits, days.length - capped.length);
  } catch (err) {
    console.error("[trustx-ledger] month audit:", err);
    out.innerHTML = ownErrorMarkup(reportError(err), "Could not check that month");
  } finally {
    setLoading(btn, false);
  }
}

/* =========================================================
   Shop — services and trusted browsers
   -----------------------------------------------------------------
   The two things an owner maintains rather than reads. Both lists are
   records the rules will not let anyone else touch, so what happens
   here is enforced rather than suggested.
   ========================================================= */

function wireShop() {
  document.getElementById("addSvcSave").addEventListener("click", saveNewService);
  document.getElementById("addSvcClear").addEventListener("click", () => {
    document.getElementById("addSvcName").value = "";
    document.getElementById("addSvcPrice").value = "";
  });
  wireSeedDefaults();
  wireDevices();
}

/** Load both lists when the tab opens. */
async function loadShop() {
  await Promise.all([loadServicesList(), loadAccessGrants()]);
}

/* ---------- Services ---------- */

/**
 * Re-run the default catalog seed. Every protected page already does this
 * on sign-in, so the button is a repair tool: it reports how much is still
 * missing, never duplicates a service, and disables itself once the catalog
 * covers the list.
 */
function wireSeedDefaults() {
  const btn = document.getElementById("seedSvcBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    let missing = [];
    try {
      const existing = await fetchServices({ includeInactive: true });
      missing = findMissingCatalogServices(existing);
    } catch (err) {
      toast(reportError(err), "error");
      return;
    }

    if (!missing.length) {
      toast("Your catalog already covers the default list.", "info");
      return;
    }

    const ok = await confirm({
      title: "Add default services",
      htmlMessage:
        '<p class="small">This adds ' + missing.length + " of " + SERVICE_CATALOG.length +
        " default services at &curren;0, in counter order. You can rename, re-price or archive any of them afterwards.</p>" +
        '<p class="small muted" style="margin-bottom:0;">' +
        missing.map((m) => escapeHtml(m.name)).join(", ") +
        "</p>",
      confirmText: "Add " + missing.length,
      variant: "primary",
    });
    if (!ok) return;

    setLoading(btn, true);
    btn.textContent = "Adding…";
    try {
      /* 25 sequential writes is a visible wait on a slow connection, so
         report progress rather than leaving the button inert. */
      const { created } = await seedDefaultServices({
        onProgress: ({ done, total }) => {
          btn.textContent = "Adding " + done + "/" + total + "…";
        },
      });
      toast(
        created.length
          ? created.length + " services added. Set your rates in the list below."
          : "Nothing to add.",
        "success",
      );
    } catch (err) {
      toast(reportError(err), "error");
    } finally {
      /* Stay inert until the refreshed list has recomputed the count. */
      setLoading(btn, true);
      loadServicesList();
    }
  });
}

/** Keep the seed button honest about how many defaults are still missing. */
function updateSeedButton(services) {
  const btn = document.getElementById("seedSvcBtn");
  if (!btn) return;
  const missing = findMissingCatalogServices(services);
  btn.textContent = missing.length
    ? "Add " + missing.length + " default" + (missing.length === 1 ? "" : "s")
    : "Defaults added";
  btn.title = missing.length
    ? "Add the " + missing.length + " default service(s) not in your catalog yet"
    : "Your catalog already covers the default list";
  setLoading(btn, missing.length === 0);
}

async function saveNewService() {
  const nameInput = document.getElementById("addSvcName");
  const priceInput = document.getElementById("addSvcPrice");
  const btn = document.getElementById("addSvcSave");
  const name = nameInput.value.trim();
  const price = priceInput.value;

  if (!name) {
    toast("Enter a service name.", "error");
    return;
  }
  if (rateToPaise(price) === null) {
    toast("Enter a valid rate.", "error");
    return;
  }

  setLoading(btn, true);
  try {
    const created = await createService({ name, price });
    nameInput.value = "";
    priceInput.value = "";
    toast('Service "' + created.name + '" added.', "success");
    await loadServicesList();
  } catch (err) {
    toast(reportError(err), "error");
  } finally {
    setLoading(btn, false);
  }
}

function serviceRow(s) {
  const id = escapeHtml(s.serviceId);
  return (
    '<div class="own-row">' +
    '<div class="own-svc-head"><div class="own-ic own-ic-service">' + svg("services") + "</div>" +
    '<div class="own-row-main"><div class="own-row-sub">' + (s.active ? "Active service" : "Archived service") + "</div></div>" +
    '<div class="own-amt"><div class="own-amt-value">' + escapeHtml("₹" + paiseToInput(s.pricePaise)) + "</div>" +
    '<div class="own-amt-sub">rate</div></div></div>' +
    '<div class="own-row-fields">' +
    '<input class="input" data-svc-name="' + id + '" type="text" maxlength="80" value="' + escapeHtml(s.name) + '" aria-label="Service name" />' +
    '<input class="input is-rate" data-svc-price="' + id + '" type="text" inputmode="decimal" value="' + escapeHtml(paiseToInput(s.pricePaise)) + '" aria-label="Rate in rupees" />' +
    "</div>" +
    '<div class="own-row-actions">' +
    '<span class="badge ' + (s.active ? "badge-success" : "badge-neutral") + '">' + (s.active ? "Active" : "Archived") + "</span>" +
    '<div class="own-row-actions-end">' +
    '<button type="button" class="btn btn-primary btn-sm" data-svc-save="' + id + '">Save</button>' +
    '<button type="button" class="btn btn-sm ' + (s.active ? "btn-secondary" : "btn-primary") + '" data-svc-toggle="' + id + '">' + (s.active ? "Archive" : "Restore") + "</button>" +
    "</div></div></div>"
  );
}

async function loadServicesList() {
  const list = document.getElementById("servicesList");
  if (!list) return;
  try {
    const services = await fetchServices({ includeInactive: true });
    updateSeedButton(services);
    list.innerHTML =
      services.map(serviceRow).join("") ||
      '<div class="own-loading">No services yet — use the box above.</div>';

    services.forEach((s) => {
      const saveBtn = list.querySelector('[data-svc-save="' + CSS.escape(s.serviceId) + '"]');
      const nameInput = list.querySelector('[data-svc-name="' + CSS.escape(s.serviceId) + '"]');
      const priceInput = list.querySelector('[data-svc-price="' + CSS.escape(s.serviceId) + '"]');
      if (!saveBtn || !nameInput || !priceInput) return;

      saveBtn.addEventListener("click", async () => {
        setLoading(saveBtn, true);
        try {
          await updateService(s.serviceId, { name: nameInput.value, price: priceInput.value });
          toast("Service updated.", "success");
          await loadServicesList();
        } catch (err) {
          toast(reportError(err), "error");
        } finally {
          setLoading(saveBtn, false);
        }
      });

      list.querySelector('[data-svc-toggle="' + CSS.escape(s.serviceId) + '"]').addEventListener("click", async () => {
        const nextActive = !s.active;
        const ok = await confirm({
          title: nextActive ? "Restore service" : "Archive service",
          message: nextActive
            ? '"' + s.name + '" will appear in the service list again.'
            : '"' + s.name + '" will be hidden from quick entry. Existing transactions are kept.',
          confirmText: nextActive ? "Restore" : "Archive",
          variant: nextActive ? "primary" : "danger",
        });
        if (!ok) return;
        try {
          await updateService(s.serviceId, { active: nextActive });
          toast(nextActive ? "Service restored." : "Service archived.", "success");
          await loadServicesList();
        } catch (err) {
          toast(reportError(err), "error");
        }
      });
    });
  } catch (err) {
    /* The seed button holds its loading state across a refresh so it cannot
       be double-clicked mid-seed — so release it here, where we know the
       count could not be recomputed. */
    const seedBtn = document.getElementById("seedSvcBtn");
    if (seedBtn) {
      setLoading(seedBtn, false);
      seedBtn.textContent = "Add defaults";
    }
    list.innerHTML = ownErrorMarkup(reportError(err));
  }
}

/* ---------- Trusted browsers ---------- */

/**
 * These rows are `accessGrants/{uid}` — the same records firestore.rules
 * checks before it serves any money, so Revoke here is not a UI state: the
 * very next read that browser makes is denied by the backend.
 */
function wireDevices() {
  document.getElementById("devicesRefreshBtn").addEventListener("click", loadAccessGrants);

  const list = document.getElementById("devicesList");
  list.addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-grant-action]");
    if (!btn) return;
    const { grantAction, grantUid } = btn.dataset;
    if (!grantUid) return;

    const isThis = grantUid === state.thisUid;

    if (grantAction === "revoke") {
      const ok = await confirm({
        title: "Revoke this browser?",
        message:
          (isThis ? "This browser will need to sign in again on its next visit. " : "") +
          "It cannot read or record anything until it is restored or signs in with Google again.",
        confirmText: "Revoke",
        variant: "danger",
      });
      if (!ok) return;
      try {
        await revokeGrant(grantUid);
        toast(isThis ? "This browser revoked. It will need the code next time." : "Browser revoked.", "success");
      } catch (err) {
        toast(reportError(err), "error");
      }
    } else if (grantAction === "restore") {
      const ok = await confirm({
        title: "Restore this browser?",
        message: "It will open the ledger with its Google account again.",
        confirmText: "Restore",
        variant: "primary",
      });
      if (!ok) return;
      try {
        await restoreGrant(grantUid);
        toast("Browser restored.", "success");
      } catch (err) {
        toast(reportError(err), "error");
      }
    } else if (grantAction === "remove") {
      const ok = await confirm({
        title: "Remove this browser?",
        message:
          (isThis ? "This browser will need to sign in again on its next visit. " : "") +
          "Its trust record is deleted and cannot be restored — it must sign in with Google again.",
        confirmText: "Remove",
        variant: "danger",
      });
      if (!ok) return;
      try {
        await removeGrant(grantUid);
        toast("Browser removed.", "success");
      } catch (err) {
        toast(reportError(err), "error");
      }
    }
    await loadAccessGrants();
  });
}

function fmtTs(ts) {
  if (!ts) return "—";
  const dt = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
  if (Number.isNaN(dt.getTime())) return "—";
  return escapeHtml(formatKolkataLong(dt) + ", " + formatKolkataTime(dt));
}

function grantRow(g) {
  const isThis = g.uid === state.thisUid;
  const isAdmin = g.role === "admin";
  const label = String(g.label || "Unnamed browser").trim() || "Unnamed browser";
  const ua = (g.client && g.client.ua) || "";
  const subBits = [ua, g.client && g.client.lang ? g.client.lang : ""].filter(Boolean);

  return (
    '<div class="own-row">' +
    '<div class="own-row-main">' +
    '<div class="own-row-title">' + escapeHtml(label) +
    (isThis ? ' <span class="badge badge-accent">This browser</span>' : "") +
    (isAdmin ? ' <span class="badge badge-neutral">Owner</span>' : "") +
    "</div>" +
    '<div class="own-row-sub">' + escapeHtml(subBits.join(" &middot; ")) + "</div>" +
    '<div class="own-row-sub small">' + "Trusted " + fmtTs(g.createdAt) +
    " &middot; Last used " + fmtTs(g.lastUsedAt) + "</div>" +
    "</div>" +
    '<div class="own-row-actions">' +
    '<span class="badge ' + (g.active ? "badge-success" : "badge-neutral") + '">' +
    (g.active ? "Active" : "Revoked") + "</span>" +
    '<div class="own-row-actions-end">' +
    (g.active
      ? '<button type="button" class="btn btn-secondary btn-sm" data-grant-action="revoke" data-grant-uid="' + escapeHtml(g.uid) + '">Revoke</button>'
      : '<button type="button" class="btn btn-primary btn-sm" data-grant-action="restore" data-grant-uid="' + escapeHtml(g.uid) + '">Restore</button>') +
    '<button type="button" class="btn btn-secondary btn-sm" data-grant-action="remove" data-grant-uid="' + escapeHtml(g.uid) + '">Remove</button>' +
    "</div></div></div>"
  );
}

async function loadAccessGrants() {
  const list = document.getElementById("devicesList");
  if (!list) return;
  try {
    const grants = await listAccessGrants();
    list.innerHTML = grants.length
      ? grants.map((g) => grantRow(g)).join("")
      : '<div class="own-loading">No trusted browsers yet.</div>';
  } catch (err) {
    console.error("[trustx-ledger] access grants:", err);
    list.innerHTML = ownErrorMarkup(reportError(err));
  }
}

/* =========================================================
   Small shared blocks of markup
   ========================================================= */

function ownStateMarkup(title, body) {
  return '<div class="state"><h3>' + escapeHtml(title) + "</h3><p>" + escapeHtml(body) + "</p></div>";
}

function ownErrorMarkup(message, title = "Could not load that") {
  return '<div class="state is-error"><h3>' + escapeHtml(title) + "</h3><p>" + escapeHtml(message) + "</p></div>";
}
