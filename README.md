<div align="center">

<!-- ═══════════════════════════════════════════════════════════
     TrustX Ledger — GitHub README
     Banner = pixel-faithful SVG replica of dashboard.html
     ══════════════════════════════════════════════════════════ -->

![TrustX Ledger Dashboard](assets/readme-banner.svg)

<br/>

[![Firebase](https://img.shields.io/badge/Firebase-12.18.0-f5a623?style=flat&logo=firebase&logoColor=white)](https://firebase.google.com)
[![PWA](https://img.shields.io/badge/PWA-Offline--First-2d8a4e?style=flat)](https://web.dev/progressive-web-apps/)
[![No Build Step](https://img.shields.io/badge/No_Build-Zero_npm_deps-4b8bbf?style=flat)](https://github.com)
[![Version](https://img.shields.io/badge/version-v0.13.1-132b1e?style=flat)](https://github.com)

</div>

---

## What is TrustX Ledger?

A **production-oriented digital ledger** for a small Indian digital-service / Akshaya-style shop. The employee works in a desktop browser and records services, payments, dues, expenses, daily closing and monthly reports in seconds — alongside the government / digital-service websites already open in other tabs.

> **No bundler. No build step. No npm install.** The Firebase SDK loads from a pinned CDN version via an import map. Open `index.html` and you're running.

---

## Current Version — v0.13.1

> **Evening entry, backfill and day closing.** The shop fills its ledger at the end of the day, so a sale can belong to a business day that is not today, and a day that was never written up must be visible rather than quietly missing.

<details>
<summary><b>📅 Calendar view</b></summary>

A Monday-first month grid showing every day as *recorded*, *closed*, *nothing entered* or *not yet*. A day with no sales is drawn as an outline, never as ₹0 — "nothing was entered here" and "nothing was sold here" are different facts, and only one of them is a gap in the books.

The `+` on a day opens the sale form for that day without leaving the calendar, so catching up a missed week is a sequence of short taps.

</details>

<details>
<summary><b>🕐 Backfill any missed day</b></summary>

The sale dialog opens with a **Business day** field defaulted to today. Choosing an earlier day files the sale against that day — the day's counters move with it, in the same atomic batch, and the form names the day out loud so a backfill is never mistaken for tonight's takings. Future days are refused by the UI and by the rules.

Backfilled rows carry a `Backfilled` badge beside the time.

</details>

<details>
<summary><b>🔒 Close and reopen a day</b></summary>

Closing writes `state`, `closedAt` and `closedBy` onto the day head without touching its counters; reopening removes the closing stamps and leaves the money exactly where it was. While a day is closed, every sale write, edit and delete is refused by `firestore.rules` — no matter what the UI allows.

</details>

<details>
<summary><b>📷 Receipt photographs in Firestore</b></summary>

The photo of a scanned receipt is saved as its own small document at `dayHeads/{dateKey}/receiptImages/{txnId}`, committed in the same batch as the sale it belongs to. The sale carries only `hasReceipt: true`, and a **Receipt** button on the row fetches the picture on demand — listing a day's sales never downloads a photograph. Reading works even on a closed day; attaching or removing does not.

**No Cloud Storage** — receipts live under the same rules, same day and same backup as the money they explain.

</details>

---

## Pages at a Glance

| Page | Purpose |
|---|---|
| `index.html` | Entry point — trusted-device gate / auth routing |
| `login.html` | Google Sign-In (receipt-paper UI) |
| `dashboard.html` | App shell, today's figures, quick services |
| `calendar.html` | Month grid — recorded, closed, missing days |
| `ledger.html` | Daily ledger — one business day, editable, day totals |
| `transactions.html` | Transaction history — all time or a single day |
| `admin.html` | Developer console (admin role only; not in the nav) |

---

## Project Structure

```
/
├── index.html            Entry point (trusted-device gate / auth routing)
├── login.html            Google Sign-In
├── dashboard.html        App shell, today's figures, quick services
├── calendar.html         Month grid: which days are recorded, which are missing
├── ledger.html           Daily ledger (one business day, editable, day totals)
├── transactions.html     Transaction history (all time or a single day)
├── admin.html            Developer console (admin code; not in the nav)
├── css/
│   ├── style.css         Design tokens + core components
│   ├── forms.css         Inputs, selects, chips, auth page, receipt aesthetic
│   ├── dashboard.css     Stat cards, quick grids, receipt dashboard
│   ├── transactions.css  Sale modal, history browser, totals
│   ├── ledger.css        Ledger toolbar, table, mobile card transform
│   ├── calendar.css      Month grid, day statuses, catch-up panel
│   ├── admin.css         Developer console rows/actions
│   └── responsive.css    Desktop-first, mobile fallback
├── js/
│   ├── firebase.js       Firebase config, lazy SDK load, offline persistence
│   ├── auth.js           Google Sign-In, trusted-device enrollment/check
│   ├── ledger.js         Firestore day heads + sales, RTDB services/expenses
│   ├── calendar.js       Pure month-grid logic — no Firebase
│   ├── day-heads.js      Pure day-head counters + per-method split — no Firebase
│   ├── day-audit.js      Pure day-integrity check — no Firebase
│   ├── day-ledger.js     Pure day-view logic — no Firebase
│   ├── service-catalog.js  Default service seed list (pure data) — no Firebase
│   ├── admin.js          Developer console rendering
│   ├── shell.js          Shared protected-page bootstrap
│   ├── sale-form.js      Shared "Record a sale" modal
│   ├── app.js            Shared init, toasts, modals, shell behavior, errors
│   └── utils.js          Money (paise), dates (Asia/Kolkata), validation
├── tests/
│   ├── ledger.mjs        Node test suite — money/validation/day-view/catalog/day-head
│   ├── calendar.mjs      Month grid, totals, missed days, backfilled-row marking
│   └── module-graph.mjs  Every named import must resolve to a real export
├── tools/
│   ├── bootstrap-access.mjs   Admin SDK tool — manage the allowlist
│   ├── cleanup-firestore.mjs  Housekeeping tool
│   └── rules-check.mjs        Firestore emulator rules test harness
├── assets/
│   ├── logo.svg
│   ├── favicon.svg
│   └── readme-banner.svg      GitHub README dashboard preview
├── firestore.rules       Firestore security rules
├── database.rules.json   Realtime Database rules
├── firebase.json         Hosting + Firestore + Realtime Database deploy config
├── package.json          Scripts (npm test), no runtime deps
└── .env.example
```

---

## Data Model

One shop · one Firebase project · **two databases**.

### Cloud Firestore — the money

| Path | Read | Write |
|---|---|---|
| `allowedUsers/{email}` | **denied** | Admin SDK only |
| `enrollments/{uid}` | **denied** | Sign-in flow (rules-checked) |
| `accessGrants/{uid}` | owner / admin | self-service or admin |
| `dayHeads/{dateKey}` | trusted devices | first sale on a day; counters only move atomically with a sale |
| `dayHeads/{dateKey}/transactions/{txnId}` | trusted devices | create (trusted + validated) · update/delete (trusted + day open) |
| `dayHeads/{dateKey}/receiptImages/{txnId}` | trusted devices (even closed) | create (trusted + open + sale exists in same batch) · never updated in-place |

**A sale and the day's totals are one atomic batch.** The rules prove the head moved by exactly that sale's `amounts` split — a sale cannot land without the day following it.

### Realtime Database — expenses only

| Path | Status |
|---|---|
| `expenses/{dateKey}/{expId}` | read: any signed-in user · write: **denied** (see `DATABASE-RULES.md`) |
| `settings/general`, `settings/security`, `settings/admin` | **denied** — moved to Firestore |
| `enrollments/{uid}`, `devices/{tokenHash}`, `admins/{uid}` | **denied** — moved to Firestore |

### Default Service Catalog

`js/service-catalog.js` seeds the catalog a shop starts from. Seeds are **idempotent** — the same document is written by any device at once, and a renamed default keeps its seed ID so renaming is never undone.

| Band | Group |
|---|---|
| 100s | Printing |
| 200s | Computer / DTP |
| 300s | Government / Certificates |
| 400s | Online services |
| 500s | Photo |
| 600s | Bill payment / Utility |
| 700s | Property / Land records |
| 800s | Certificates / Vital records |

---

## Access — Google Sign-In + Allowlist

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SECURE ACCESS FLOW                              ● TrustX VERIFIED       │
├─────────────────────────────────────────────────────────────────────────┤
│  1. User opens login.html → clicks "Sign in with Google"                │
│  2. Firebase verifies the Google credential                             │
│  3. Rules compare email against allowedUsers/{email}                    │
│     (unreadable by any client — Admin SDK only)                         │
│  4. On success: accessGrants/{uid} is minted                            │
│  5. Every money rule calls trusted() → reads that grant                 │
│  6. Later visits: browser keeps Google session, auto-signs in           │
└─────────────────────────────────────────────────────────────────────────┘
```

### First-time setup (one-time, by the shop owner)

```bash
# Add the first admin before anyone can log in
node tools/bootstrap-access.mjs --key <service-account.json> \
  --add owner@gmail.com --role admin
```

Other commands:

```bash
node tools/bootstrap-access.mjs --key <sa.json> --add worker@gmail.com --role shop
node tools/bootstrap-access.mjs --key <sa.json> --list              # who has access
node tools/bootstrap-access.mjs --key <sa.json> --remove worker@gmail.com
node tools/bootstrap-access.mjs --key <sa.json> --list-grants       # trusted browsers
node tools/bootstrap-access.mjs --key <sa.json> --revoke <uid>      # lock a browser out
```

### Two roles

| Role | Capability |
|---|---|
| `shop` | Full ledger access |
| `admin` | Ledger + Developer console (trusted browsers, services, all-data view) |

---

## Run Locally

Any static file server works. No build step, no npm install:

```bash
npx serve .
# or
python -m http.server 8080
```

Then open `http://localhost:3000/` (or the printed port).

> The shell renders fully offline. Only Firebase-backed actions need internet — they queue locally when offline and sync automatically.

---

## Connect Firebase

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
2. **Add app → Web app** and register a nickname.
3. Copy the `firebaseConfig` block from **Project settings → Your apps**.
4. Edit `js/firebase.js` and replace every `YOUR_*` placeholder.
5. Enable **Authentication → Sign-in method → Google**.

> **Cloud Storage is not used** and does not need to exist. Receipt photographs live in Firestore (`dayHeads/{dateKey}/receiptImages/{txnId}`).

---

## Deploy

```bash
firebase deploy --only hosting
firebase deploy --only firestore     # rules + indexes
firebase deploy --only database      # Realtime Database rules
```

---

## Tests

```bash
npm test
# or
node --test tests/ledger.mjs tests/calendar.mjs
```

```bash
npm run test:rules   # Firestore emulator rules harness (136 cases, 0 skipped)
```

`tests/module-graph.mjs` walks the real import graph and asserts every named import resolves, and no dead exports accumulate.

---

## Design System Quick Reference

| Token | Value |
|---|---|
| `--color-primary` | `#4b8bbf` (warm sky-blue) |
| `--color-accent` | `#f5a623` (amber / sunlight) |
| `--color-bg` | `#fdf8ee` (warm parchment) |
| `--color-sidebar-bg` | `#132b1e` (deep forest green) |
| `--color-success` | `#2d8a4e` (lush forest green) |
| `--font-sans` | Nunito — friendly, rounded, warm |
| Money | Integer paise (`₹10.50 → 1050`) — no floating point |
| Dates | `Asia/Kolkata` (`YYYY-MM-DD` date keys) |

| Key | Action |
|---|---|
| `Ctrl/⌘ + N` | Open "Record a sale" dialog |
| `Esc` | Close any modal or mobile sidebar |

---

## Troubleshooting

<details>
<summary><b>"Firebase is not configured yet."</b></summary>

Replace the `YOUR_*` values in `js/firebase.js`.

</details>

<details>
<summary><b>"That Google account is not authorised for this shop."</b></summary>

```bash
node tools/bootstrap-access.mjs --key <service-account.json> \
  --add owner@gmail.com --role admin
firebase deploy --only firestore
```

</details>

<details>
<summary><b>"Realtime Database is not reachable."</b></summary>

`databaseURL` in `js/firebase.js` is wrong or the database was never created. Sales (Firestore) still work; expenses are unavailable until fixed.

</details>

<details>
<summary><b>The console stays on the locked card.</b></summary>

```bash
node tools/bootstrap-access.mjs --key <sa.json> --add you@gmail.com --role admin
```

</details>

<details>
<summary><b>"The ledger refused that sale."</b></summary>

The rules re-derive `total = quantity × rate` and verify the head delta. Common causes: zero rate/quantity, deactivated service, or the day is closed. Check the browser console.

</details>

---

## Version History

| Version | Highlight |
|---|---|
| **v0.13.1** | Receipt photographs in Firestore subcollection; rules fix for optional fields — 136 rule cases, 0 skipped |
| **v0.13.0** | Calendar, backfill, business-day field, day close/reopen |
| **v0.12.0** | Google Sign-In replaces access codes; server-enforced allowlist |
| **v0.11.0** | SHA-256 hashed access codes; Admin SDK bootstrap tool |
| **v0.10.0** | Admin role gate; Developer console |
| **v0.9.0** | Daily ledger; edit/delete; day-head close register; cursor paging |

---

<div align="center">

**TrustX Ledger &nbsp;·&nbsp; v0.13.1**  
*Fast · Offline-First · Single-Shop · ₹ INR*

</div>
