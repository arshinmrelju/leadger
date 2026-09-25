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

**Transactional build (Part 4 of 10).** A single shop records real sales on a
dedicated `/transactions` page and sees them reflected on the dashboard
immediately — all real Firestore reads/writes, no mock data.

- **Record a sale** in seconds: pick a service (or add one inline), set
  quantity and rate, tap **Cash / UPI / Card / Due**, optional customer name,
  **Save**. The rate pre-fills from the service's price and the total updates
  live.
- **Payment method drives status**: paid for cash/UPI/card, pending for due.
- **Today's receipts** list on the same page: refreshable, with per-payment
  badges, totals and an empty/offline state. Offline saves queue locally and
  show "Saved — will sync"; a green "Changes synced" confirms when they land.
- **Dashboard is wired to real data**: today's revenue, count, cash/UPI/card,
  dues, expenses and net come from today's `transactions` and `expenses`
  reads; quick-service buttons deep-link into the entry form.
- **One-shop model**: no `shops/{shopId}/...` paths anywhere. Collections are
  top-level; the owner bootstraps on first run, staff join by invite or the
  shop access code, and roles (Admin/Employee) gate the UI and the rules.

Performance: only today's rows are ever queried (one indexed read), kept
sorted by `createdAt` DESC; no long-lived listeners on the dashboard —
one-shot reads, a refresh button, and online/offline events.

Money is **integer paise**; `dateKey` is the `YYYY-MM-DD` Asia/Kolkata
business day; `createdAt` is the Firestore timestamp used for ordering.
NET = today's collections − today's expenses (dues are money not yet
received and are excluded).

> **Deploy required:** run `firebase deploy --only firestore` so the new
> single-shop rules and the composite index behind today's list
> (`dateKey` ASC + `createdAt` DESC) go live before testing. Existing data
> under the old `shops/{shopId}/...` layout is orphaned by this build.

## Project structure

```
/
├── index.html            Entry point (boot / auth routing / setup notice)
├── login.html            Sign in, create account, Google, shop access code
├── dashboard.html        App shell, today's figures, members & access code
├── transactions.html     Record a sale (new transaction entry + today's list)
├── css/
│   ├── style.css         Design tokens + core components
│   ├── forms.css         Inputs, selects, chips, auth page
│   ├── dashboard.css     Stat cards, quick grids, entry panel
│   ├── transactions.css  Transaction entry (segmented payment, hide, totals)
│   └── responsive.css    Desktop-first, mobile fallback
├── js/
│   ├── firebase.js       Firebase config, lazy SDK load, offline persistence
│   ├── auth.js           Auth, memberships, roles, invites, access code
│   ├── ledger.js         Transactions/services reads + writes + day summary
│   ├── shell.js          Shared protected-page bootstrap (chip, shields, keys)
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
| `settings/general` | signed-in members | first run only (owner bootstrap) |
| `settings/security` | admin only | admin only (access code / security) |
| `members/{uid}` | signed-in members | self-create on first run & code join; admin role/active changes |
| `pendingMembers/{email}` | members | invites by admin    |
| `transactions/{txnId}` | signed-in members | any signed-in member, server-validated |
| `services/{serviceId}` | signed-in members | any signed-in member |
| `expenses/{expId}` | signed-in members | (writing arrives in a later build) |

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
5. Enable sign-in methods:
   **Authentication → Sign-in method**: **Google**, **Email/Password** and —
   for the shop access code to work — **Anonymous**.
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

## Shop access code

The code is a per-store door key like `TRUSTX01` (8 characters, `A-Z0-9`).

- **How staff use it:** sign in with the code on `login.html`. The app signs
  in anonymously (turn on **Anonymous** auth), verifies the code against
  `settings/security` server-side, and creates that member. The persistent
  session keeps the shop computer signed in — set it up once, it stays in.
- **How the admin sets it:** on the Dashboard's **Shop access code** block —
  Set / Change / Copy, generating codes like `TRUSTX01` automatically.
- **Where it lives:** `settings/security` (admin-write, staff cannot read
  it); the security rules compare the presented code (**hashed**) against the
  stored one whenever a membership is created or joined, so shop data stays
  hidden unless the code is right.
- **"Auto-login on shop Wi-Fi" is a convenience, not a security boundary.** A
  browser cannot read the Wi-Fi SSID; the account session is what persists.
- **Deliberately simple trade-off:** no server-side lockout counter — the code
  itself is the protection: 8 chars of `A-Z0-9` is about 2.8 trillion
  combinations. Keep it private; the admin can change it anytime. Sharing the
  code gives someone employee-level access to the shop.

## Tests

Pure money/validation helpers (`js/utils.js`) are unit-tested with Node's
built-in runner — no installs needed:

```bash
npm test
# or
node --test tests/ledger.mjs
```

A Firestore emulator rules suite (deny anonymous/all, admin-only settings,
server-side `total == quantity * rate`, invite/access-code join flows, owner
protection) is planned for a later hardening pass.

## Design system quick reference

- Money is handled as **integer paise** (`₹10.50` → `1050`) in `utils.js`
  (`toPaise`, `formatINR`, `rateToPaise`, `computeTotalPaise`,
  `sanitizeQuantity`). Floating point is never used for totals.
- Dates always resolve to `Asia/Kolkata` (`kolkataDateKey`, `todayKolkata`).
- UI helpers live in `js/app.js`:
  `toast(msg, type)`, `confirm({...})`, `setSyncState(state)`,
  `setLoading(button, bool)`.
- Logged-in pages bootstrap through `js/shell.js` `initAppShell({ page,
  onReady, onDayChange })` — renders the user chip, first-run / disabled /
  no-access shields, sync pill, day rollover and global keys.
- Ledger data lives in `js/ledger.js`:
  `fetchTodaySummary(dateKey?)`, `fetchServices()`,
  `createTransaction({ serviceId, serviceName, quantity, rate, paymentMethod,
  customerName, dateKey })` (rate in rupees, stored as paise),
  `createService({ name, price })`, `flushPendingWrites()`,
  `normalizeTxn()`, `isNetworkError(err)`.
- Global uncaught errors are logged and surface as a friendly toast — raw
  Firebase errors are never shown to employees.

## Keyboard conventions

- `Esc` closes any open modal or the mobile sidebar.
- `Ctrl/⌘+N` jumps to the Transactions page (or focuses the entry form if
  you're already there).

## Troubleshooting

- **"Firebase is not configured yet."** — Replace the `YOUR_*` values in
  `js/firebase.js` (see *Connect Firebase* above).
- **"Shop access code not recognised."** — the code doesn't match, or the
  admin hasn't set one yet (or just changed it). Codes are 8 characters
  (`A-Z0-9`).
- **Member can't get in via email** — they must sign in with the exact email
  the admin invited; the invitation is claimed on the *first* sign-in with
  that email.
- **Blank page / console silence** — open the browser console (F12) and look
  for a red error; report the message.
- **Rules blocked a read/write** — rules intentionally deny anything not
  authorized by the membership model; settings and member management are
  admin-only. A save failing on `createTransaction` with a money mismatch
  normally means a service's `pricePaise` in Firestore isn't an integer —
  re-add the service from the Transactions page.

## Roadmap (this 10-part build)

1. ✅ Foundation: structure, shell, design system, Firebase wiring
2. ✅ Authentication & onboarding: sign-in, memberships, roles, invitations, shop code, rules
3. ✅ Today's dashboard: live Firestore figures, recent transactions, sync status, quick services
4. 🔄 **Transaction system (this build):** record-sale page, inline services,
   payment methods, offline queue, dashboard wiring, flat single-shop data
   model. *Remaining:* daily ledger (date filters, edit, due→paid, CSV).
5. Customers
6. Expenses
7. Daily closing
8. Reports & service statistics
9. Settings, services, employee & role management
10. Offline sync polish, security-rule tests, deployment hardening