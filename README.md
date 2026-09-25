# SEVA LEDGER

A lightweight, production-oriented digital service shop ledger for a small
Indian digital-service / Akshaya-style shop. The employee works in a desktop
browser and records services, payments, dues, expenses, daily closing and
monthly reports in seconds — alongside the government/digital-service
websites he already uses in other tabs.

| | |
|---|---|
| **App** | SEVA LEDGER |
| **Currency** | Indian Rupee (`₹`) |
| **Primary timezone** | `Asia/Kolkata` (database date keys are `YYYY-MM-DD` in Kolkata time) |
| **Stack** | HTML5 · CSS3 · Vanilla JS (ES6+) · Firebase (Auth, Cloud Firestore, Hosting) |
| **Offline** | Firestore IndexedDB persistence (multi-tab) — data survives internet loss and syncs automatically |

## Current status

**Single-code login (v0.6.0).** The whole app opens with one shared code —
`TRUSTX` — typed on `login.html`. Entering it signs the browser in to
Firestore (anonymous auth) and grants **full access to everything**,
including the **Developer console** (`admin.html`):

- **Services**: add, rename, re-price, archive/restore the catalog.
- **All data**: transactions (per day or most recent) with totals, plus the
  expenses list — a read-only back-office view.

The dashboard and the record-a-sale page (`/transactions`) stay operational,
backed by the offline queue.

Everything is still the **transactional build** under the hood: record-a-sale,
live dashboard, offline queue, integer-paise money, `Asia/Kolkata` date keys.

Performance: only today's rows are ever queried (one indexed read), kept
sorted by `createdAt` DESC; no long-lived listeners on the dashboard —
one-shot reads, a refresh button, and online/offline events.

Money is **integer paise**; `dateKey` is the `YYYY-MM-DD` Asia/Kolkata
business day; `createdAt` is the Firestore timestamp used for ordering.
NET = today's collections − today's expenses (dues are money not yet
received and are excluded).

> **Deploy required:** run `firebase deploy --only firestore` first — the
> rules move from the account/membership model to the code model. The
> composite index behind today's list (`dateKey` ASC + `createdAt` DESC) is
> unchanged. Existing `members/`, `pendingMembers/` and `settings/security`
> documents are no longer used (denied by the rules) but can stay in place.

## Project structure

```
/
├── index.html            Entry point (boot / auth routing / setup notice)
├── login.html            Single-code sign in (enter the shop code)
├── dashboard.html        App shell, today's figures, quick services
├── transactions.html     Record a sale (new transaction entry + today's list)
├── admin.html            Developer console (services + all data)
├── css/
│   ├── style.css         Design tokens + core components
│   ├── forms.css         Inputs, selects, chips, auth page
│   ├── dashboard.css     Stat cards, quick grids, entry panel
│   ├── transactions.css  Transaction entry (segmented payment, hide, totals)
│   ├── admin.css         Developer console rows/actions
│   └── responsive.css    Desktop-first, mobile fallback
├── js/
│   ├── firebase.js       Firebase config, lazy SDK load, offline persistence
│   ├── auth.js           Single-code sign-in, shop record bootstrap
│   ├── ledger.js         Transactions/services reads + writes + day summary
│   ├── admin.js          Developer console rendering
│   ├── shell.js          Shared protected-page bootstrap (chip, sync, keys)
│   ├── app.js            Shared init, toasts, modals, shell behavior, errors
│   └── utils.js          Money (paise), dates (Asia/Kolkata), validation
├── tests/
│   └── ledger.mjs        Node test suite for money/validation helpers
├── package.json          Scripts (npm test), no runtime deps
├── assets/
│   ├── logo.svg
│   └── favicon.svg
├── firestore.rules       Security rules (single-shop model enforced here)
├── firestore.indexes.json
├── firebase.json         Firebase Hosting + Firestore deploy config
├── .env.example
└── README.md
```

The Firebase modular SDK is loaded from a **pinned CDN version (12.18.0)**
via an import map in each page. There is no bundler, no npm install, and no
build step to run the app.

## Data model (single shop)

All collections are top-level — there is no `shops/` path:

| Path | Read | Write |
|---|---|---|
| `settings/general` | code-signed-in devices | auto-created on first use; any signed-in device may edit |
| `transactions/{txnId}` | code-signed-in devices | signed-in, server-validated (`createdBy == uid`, money checks) |
| `services/{serviceId}` | code-signed-in devices | signed-in; `delete` always denied (archive via `active=false`) |
| `expenses/{expId}` | code-signed-in devices | (writing arrives in a later build) |

A transaction document: `serviceId`, `serviceName`, `quantity`,
`rate` (paise/unit), `total` (`quantity * rate` — re-verified server-side),
`paymentMethod` (`cash`/`upi`/`card`/`due`), `status` (`paid`/`pending`,
derived from method), `customerId`/`customerName` (customer name optional),
`dateKey`, `createdAt`/`updatedAt`, `createdBy`/`updatedBy`.

## Run locally

Any static file server works. From the project root:

```bash
npx serve .
# or
python -m http.server 8080
```

Then open <http://localhost:3000/> (or the printed port).

> The shell renders fully offline. Only Firebase-backed actions need an
> internet connection (they queue locally when offline), and the browser caches
> the SDK after the first successful load.

## Connect Firebase

1. Create a project at <https://console.firebase.google.com>.
2. **Add app → Web app** and register a nickname (e.g. `seva-ledger`).
3. Open **Project settings → Your apps** and copy the `firebaseConfig` block.
4. Edit `js/firebase.js` and replace **every** `YOUR_*` placeholder
   (`apiKey`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`).
5. Enable the sign-in method the app needs:
   **Authentication → Sign-in method → Anonymous**.
   The free Spark plan is enough — **no Cloud Functions are required**.

Firebase **client configuration is not a secret** — it goes in the frontend
by design. All real security lives in `firestore.rules` and Authentication.
Never paste service-account or admin private keys into frontend code.

The app detects the placeholders and stays in a safe "setup needed" mode
until a real config is present, so nothing is ever exposed by misconfiguration.

## Add your project to the Firebase CLI

```bash
firebase login
firebase use --add        # select or create the project, e.g. alias "default"
```

You can also put the project id in `.env` (see `.env.example`).

## Deploy to Firebase Hosting & Firestore

```bash
firebase deploy --only hosting
firebase deploy --only firestore     # rules + indexes
```

## Access

The whole shop opens with one shared code: **`TRUSTX`** (case-insensitive,
no spaces — `trustx` works).

- **How it works:** type the code on `login.html`. It is checked against the
  constant `SHOP_CODE` in `js/auth.js`; if it matches, the browser signs in
  to Firebase **anonymously** and creates a persistent device session, so a
  shop computer stays signed in once set up. Everyone who has the code gets
  **full access**, including the Developer console.
- **No accounts, no roles, no members.** The `members/`, `pendingMembers/`
  and `settings/security` collections from earlier builds are gone; old data
  in those paths is simply unreachable.
- **Honest trade-off:** because the code is a fixed constant checked in the
  browser, anyone who reads the app source can bypass it. Firestore does not
  treat it as a security boundary — its rules require a signed-in (anonymous)
  user and enforce record integrity (typed fields, `createdBy == uid`,
  `total == quantity * rate`, service must exist and be active, no deletes).
  Keep the code private among the people who use the shop.
- **Sign out** returns to the login screen; the same browser can sign back in
  with the code (its session normally persists).

## Tests

Pure money/validation helpers (`js/utils.js`) are unit-tested with Node's
built-in runner — no installs needed:

```bash
npm test
# or
node --test tests/ledger.mjs
```

A Firestore emulator rules suite (signed-in-only access with per-document
validation, money integrity, no-delete guarantees) is planned for a later
hardening pass.

## Design system quick reference

- Money is handled as **integer paise** (`₹10.50` → `1050`) in `utils.js`
  (`toPaise`, `formatINR`, `rateToPaise`, `computeTotalPaise`,
  `sanitizeQuantity`). Floating point is never used for totals.
- Dates always resolve to `Asia/Kolkata` (`kolkataDateKey`, `todayKolkata`).
- UI helpers live in `js/app.js`:
  `toast(msg, type)`, `confirm({...})`, `setSyncState(state)`,
  `setLoading(button, bool)`.
- Logged-in pages bootstrap through `js/shell.js` `initAppShell({ page,
  onReady, onDayChange })` — renders the user chip, sync pill, day rollover,
  global keys, and ensures the shop record exists.
- The Developer console lives in `js/admin.js`:
  `renderAdminPage(ctx)` — service maintenance and the all-data browser.
- Sign-in lives in `js/auth.js`:
  `SHOP_CODE` (the constant), `isCorrectCode(input)`, `signInAnonymous()`,
  `ensureShopRecord()` (silently creates `settings/general` on first use),
  `getGeneral()`.
- Ledger data lives in `js/ledger.js`:
  `fetchTodaySummary(dateKey?)`, `fetchServices({ includeInactive })`,
  `createTransaction({ serviceId, serviceName, quantity, rate, paymentMethod,
  customerName, dateKey })` (rate in rupees, stored as paise),
  `createService({ name, price })`, `updateService(serviceId, { name, price,
  active })`, `fetchTransactions({ dateKey, limit })`,
  `fetchExpenses({ dateKey, limit })`, `flushPendingWrites()`,
  `normalizeTxn()`, `isNetworkError(err)`.
- Global uncaught errors are logged and surface as a friendly toast — raw
  Firebase errors are never shown to users.

## Keyboard conventions

- `Esc` closes any open modal or the mobile sidebar.
- `Ctrl/⌘+N` jumps to the Transactions page (or focuses the entry form if
  you're already there).

## Troubleshooting

- **"Firebase is not configured yet."** — Replace the `YOUR_*` values in
  `js/firebase.js` (see *Connect Firebase* above).
- **"Shop code not recognised."** — the code you typed isn't `TRUSTX`.
  Try again, or open `js/auth.js` and change `SHOP_CODE` (then redeploy).
- **Blank page / console silence** — open the browser console (F12) and look
  for a red error; report the message.
- **Rules blocked a read/write** — rules deny signed-out access and anything
  not type-safe. A save failing on `createTransaction` with a money mismatch
  normally means a service's `pricePaise` in Firestore isn't an integer —
  re-add the service from the Developer console.

## Roadmap (this 10-part build)

1. ✅ Foundation: structure, shell, design system, Firebase wiring
2. ✅ Single-code sign-in: one shared code, anonymous auth, full access, shop record bootstrap
3. ✅ Today's dashboard: live Firestore figures, recent transactions, sync status, quick services
4. 🔄 Transaction system: record-sale page, inline services, payment
   methods, offline queue, dashboard wiring, flat single-shop data model.
   *Remaining:* daily ledger (date filters, edit, due→paid, CSV).
5. 🔄 **Developer console (this build):** `admin.html` — services
   maintenance and the all-data browser.
6. Customers
7. Expenses
8. Daily closing
9. Reports & service statistics
10. Settings polish, security-rule tests, deployment hardening