# TrustX Ledger

A lightweight, production-oriented digital service shop ledger for a small
Indian digital-service / Akshaya-style shop. The employee works in a desktop
browser and records services, payments, dues, expenses, daily closing and
monthly reports in seconds — alongside the government/digital-service
websites he already uses in other tabs.

| | |
|---|---|
| **App** | TrustX Ledger |
| **Currency** | Indian Rupee (`₹`) |
| **Primary timezone** | `Asia/Kolkata` (database date keys are `YYYY-MM-DD` in Kolkata time) |
| **Stack** | HTML5 · CSS3 · Vanilla JS (ES6+) · Firebase (Auth, Cloud Firestore, Hosting) |
| **Offline** | Firestore IndexedDB persistence (multi-tab) — data survives internet loss and syncs automatically |

## Current status

**Daily ledger (v0.9.0).** `ledger.html` is the shop's day book. It opens on
today's `Asia/Kolkata` business day and shows one row per sale — time,
service, quantity, rate, total, payment, customer, status — with running
totals for transactions, revenue, cash, UPI, card and due underneath.

- **Date navigation:** a date picker, previous/next day, and a **Today**
  button. Following a day to the next one is a single indexed read scoped by
  `dateKey`, so the ledger never downloads history it is not showing.
- **Search and filters** (service/customer text, payment method, status) run
  client-side over the rows already in memory. The search box is debounced at
  250 ms, so typing never turns into a Firestore request per keystroke.
- **Edit, delete, and mark-due-as-paid** are available to any signed-in
  device while the business day is still open. Edits refresh `updatedAt` /
  `updatedBy`; the rules re-derive `total` from `quantity × rate` and pin
  `txnId`, `serviceId`, `createdAt`, `createdBy` and `dateKey` so a sale can
  never be silently re-dated or have its service name drift from the catalog.
- **Closed days are read-only.** When a `days/{dateKey}` document exists the
  page shows a "day is closed" notice, disables the row actions, and the rules
  reject the write server-side regardless of what the UI allows.
- **Pagination is prepared** with cursor paging (`orderBy createdAt DESC,
  __name__ DESC` + `startAfter`), so a busy day degrades into "Load more"
  instead of a silent truncation. The transaction count in the footer comes
  from a count aggregate, so it is right even while only one page is loaded.
- **Responsive:** a desktop table that becomes one card per sale below
  760 px, using the same markup.

**Trusted-device login (v0.7.0).** One shared code opens the whole app. The
first time a browser enters the code it becomes a **trusted device**: it
stores a random 256-bit credential locally and skips the code on every later
visit — until someone revokes it from the Developer console. The access code
itself now lives **server-side** (`settings/security`): Firestore rules verify
enrollment, so the code constant in the client is only a default and no
plaintext secret is ever readable from the app source.

The Developer console (`admin.html`) gives code-signed-in devices **full
access**, including a **Trusted devices** manager (revoke/restore/remove any
browser) and:

- **Services**: add, rename, re-price, archive/restore the catalog.
- **All data**: transactions (per day or most recent) with totals, plus the
  expenses list — a read-only back-office view. The interactive day book now
  lives in `ledger.html`; this panel is unchanged.

The dashboard, the record-a-sale dialog and the daily ledger stay
operational, backed by the offline queue.

Everything is still the **transactional build** under the hood: record-a-sale,
live dashboard, daily ledger, offline queue, integer-paise money,
`Asia/Kolkata` date keys.

Performance: only the rows for the day on screen are ever queried (one
indexed read per page), kept sorted by `createdAt` DESC; no long-lived
listeners — one-shot reads, a refresh button, and online/offline events.

Money is **integer paise**; `dateKey` is the `YYYY-MM-DD` Asia/Kolkata
business day; `createdAt` is the Firestore timestamp used for ordering.
NET = today's collections − today's expenses (dues are money not yet
received and are excluded).

> **Deploy required:** run `firebase deploy --only firestore` first — the
> rules now add the trust registry (`settings/security`, `enrollments/**`,
> `devices/**`) and allow the auto-login gate to read a device doc by its
> unguessable hash id before any session exists. v0.9.0 additionally opens
> `transactions` to validated `update`/`delete` while the day is open, adds
> the read-only `days/{dateKey}` close register, and extends the composite
> index behind the ledger's cursor paging (`dateKey` ASC + `createdAt` DESC
> + `__name__` DESC). Existing `members/`, `pendingMembers/` and old
> `settings/security` documents are no longer used (denied by the rules) but
> can stay in place. Every already enrolled browser re-verifies once with the
> code after the trust-registry deploy.

## Project structure

```
/
├── index.html            Entry point (trusted-device gate / auth routing)
├── login.html            Shop-code sign in (enrolls this browser as trusted)
├── dashboard.html        App shell, today's figures, quick services
├── ledger.html           Daily ledger (one business day, editable, day totals)
├── transactions.html     Transaction history (all time or a single day)
├── admin.html            Developer console (services, trusted devices, all data)
├── css/
│   ├── style.css         Design tokens + core components
│   ├── forms.css         Inputs, selects, chips, auth page
│   ├── dashboard.css     Stat cards, quick grids, entry panel
│   ├── transactions.css  Sale modal, history browser, totals
│   ├── ledger.css        Ledger toolbar, table, mobile card transform
│   ├── admin.css         Developer console rows/actions
│   └── responsive.css    Desktop-first, mobile fallback
├── js/
│   ├── firebase.js       Firebase config, lazy SDK load, offline persistence
│   ├── auth.js           Code sign-in, trusted-device enrollment/check, shop bootstrap
│   ├── ledger.js         Transactions/services reads + writes + day queries
│   ├── day-ledger.js     Pure day-view logic (date shift, filter, totals) — no Firebase
│   ├── admin.js          Developer console rendering
│   ├── shell.js          Shared protected-page bootstrap (chip, date, keys)
│   ├── sale-form.js      Shared "Record a sale" modal (openSaleForm/onSaleRecorded)
│   ├── app.js            Shared init, toasts, modals, shell behavior, errors
│   └── utils.js          Money (paise), dates (Asia/Kolkata), validation
├── tests/
│   └── ledger.mjs        Node test suite for money/validation/day-view helpers
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
| `settings/security` | **never readable or writable by clients** | seeded with the default code on first use; enrollment rules compare against it server-side |
| `enrollments/{nonce}` | denied | one-time proof-of-code (single use, owner-burn) during first-time device setup |
| `devices/{tokenHash}` | signed-in devices (list); unauthenticated GET **by unguessable hash id** (the auto-login gate) | enrollment creates; owner heartbeats/renames/restores; any signed-in device may revoke or remove |
| `transactions/{txnId}` | code-signed-in devices | create: signed-in, server-validated (`createdBy == uid`, money checks). update/delete: signed-in **and the day is still open** |
| `services/{serviceId}` | code-signed-in devices | signed-in; `delete` always denied (archive via `active=false`) |
| `expenses/{expId}` | code-signed-in devices | (writing arrives in a later build) |
| `days/{dateKey}` | code-signed-in devices | absent document = day is **open**; a present document is a closed day, written once and never updated or deleted |

A transaction document: `serviceId`, `serviceName`, `quantity`,
`rate` (paise/unit), `total` (`quantity * rate` — re-verified server-side),
`paymentMethod` (`cash`/`upi`/`card`/`due`), `status` (`paid`/`pending`,
derived from method), `customerId`/`customerName` (customer name optional),
`dateKey`, `createdAt`/`updatedAt`, `createdBy`/`updatedBy`.

On an edit the rules pin `txnId`, `serviceId`, `customerId`, `dateKey`,
`createdAt` and `createdBy` to the stored row, so only the descriptive
fields move. That is what makes a sale impossible to re-date onto a
different business day, and it is why the editor offers a **service picker**
rather than a free-text name: `serviceName` must equal the live
`services/{serviceId}.name`, so typed names would only ever be rejected.
`updatedAt`/`updatedBy` are always rewritten.

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
2. **Add app → Web app** and register a nickname (e.g. `trustx-ledger`).
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
no spaces — `trustx` works). It is the code seeded into
`settings/security` on first use; Firestore rules compare an enrollment
attempt against it, so approval happens on the server, not in page scripts.

**How it works:**

1. **First visit (`login.html`):** enter the code. The app signs in
   anonymously (a real Firebase session) and writes a one-time
   `enrollments/{nonce}` proof-of-code. The rules only accept it if the
   submitted code equals the code stored in `settings/security`. It then
   creates an **active** `devices/{tokenHash}` doc — where `tokenHash` is
   the SHA-256 of a fresh 256-bit random token kept **only in the browser's
   IndexedDB** (never in localStorage, URLs, or the network) — and burns the
   enrollment.
2. **Later visits (`index.html`):** the trust gate hashes the stored token
   and reads `devices/<hash>` **before any session exists** (the id itself
   is the proof — it is unguessable). If the doc exists and is `active`, the
   app signs in automatically and you land on the dashboard. No code typed.
3. **Revoked or removed browsers** land on `login.html` and must enter the
   code again; re-verification issues a brand-new token. `/transactions`,
   `/dashboard` and `/admin` are trust-gated too, so a revoked session is
   redirected even if the browser kept an old anonymous session.
4. **Managing devices:** any signed-in device can open the Developer console →
   **Trusted devices** and revoke / restore / remove any browser (that's the
   "what if the code leaks?" valve: revoke everything, then re-verify on the
   trusted computer).

- **No accounts, no roles, no members.** Everyone who proves the code gets
  **full access**, including the Developer console. `members/` and
  `pendingMembers/` from earlier builds are gone; old data in those paths is
  unreachable.
- **Honest trade-offs:** the shared code is see-and-share (anyone who gets it
  can enroll a device), and a device credential is only as safe as the
  browser profile holding it. The code is never stored or transmitted in
  plaintext in the app source past the default seed; brute-forcing enrollment
  is limited by single-use nonces and short-lived anonymous sessions, and
  hardened further with Firebase **App Check** (recommended for production).
  Keep the code private among the people who use the shop.
- **Sign out** returns to the login screen. Because the browser stays a
  trusted device, it signs back in automatically — to stop that on a given
  computer, revoke it from the Developer console (or clear the site data).

## Tests

Pure money/validation helpers (`js/utils.js`) and the pure day-view helpers
(`js/day-ledger.js`) are unit-tested with Node's built-in runner — no
installs needed:

```bash
npm test
# or
node --test tests/ledger.mjs
```

`day-ledger.js` is deliberately kept free of any Firebase import so the
daily-ledger behaviour is testable in Node: date shifting across month,
year and leap-day boundaries, the search/payment/status narrowing, the
per-method day totals, cursor-page merging, and the Asia/Kolkata entry
time.

A Firestore emulator rules suite (signed-in-only access with per-document
validation, money integrity, day-close enforcement) is planned for a later
hardening pass.

## Design system quick reference

- Money is handled as **integer paise** (`₹10.50` → `1050`) in `utils.js`
  (`toPaise`, `formatINR`, `rateToPaise`, `computeTotalPaise`,
  `sanitizeQuantity`). Floating point is never used for totals.
- Dates always resolve to `Asia/Kolkata` (`kolkataDateKey`, `todayKolkata`).
- Day-view helpers live in `js/day-ledger.js` (no Firebase import):
  `shiftDateKey`, `dayHeading`, `formatEntryTime`, `filterDayRows`,
  `dayTotals`, `mergeDayPage`, `sortDayRows`.
- Day-scoped reads/writes live in `js/ledger.js`:
  `fetchDayPage({ dateKey, pageSize, cursor })`, `countDayTransactions`,
  `fetchDayState`, `updateTransaction`, `markTransactionPaid`,
  `deleteTransaction`.
- UI helpers live in `js/app.js`:
  `toast(msg, type)`, `confirm({...})`,
  `setLoading(button, bool)`.
- Logged-in pages bootstrap through `js/shell.js` `initAppShell({ page,
  onReady, onDayChange })` — renders the user chip, day rollover,
  global keys, and ensures the shop record exists.
- The Developer console lives in `js/admin.js`:
  `renderAdminPage(ctx)` — service maintenance and the all-data browser.
- Sign-in and trusted devices live in `js/auth.js`:
  `SHOP_CODE` (the seeded default), `signInAnonymous()`,
  `ensureShopRecord()` (silently creates `settings/general` and seeds
  `settings/security` on first use), `getGeneral()`,
  `enrollDevice({ label })` (server-verified, stores the credential),
  `checkTrustedDevice()` (capability read of `devices/<hash>`),
  `listTrustedDevices()`, `revokeDevice/restoreDevice/removeDevice`,
  `updateDeviceLastUsed(hash)`, `generateDeviceToken()`, plus the
  IndexedDB helpers (`loadDeviceCredential`, `saveDeviceCredential`,
  `clearDeviceCredential`) and `canStoreDeviceCredential()`.
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
- **"That code is not recognised."** — the code you typed doesn't match the
  code stored in `settings/security`. The default seed is `TRUSTX`; it can
  only be changed from the Firebase console (edit the `security` document)
  or by re-seeding — there is intentionally no in-app setter.
- **`auth/configuration-not-found`** — the Firebase project behind your web
  API key isn't available to the browser SDK. Confirm the key in
  `js/firebase.js` is the real Web API key for your project, the right
  project is selected, and **Authentication → Sign-in method → Anonymous**
  is enabled, then redeploy.
- **A trusted browser suddenly asks for the code again** — either someone
  revoked/removed it from the Developer console, or the browser's site data
  (and so the credential) was cleared.
- **Blank page / console silence** — open the browser console (F12) and look
  for a red error; report the message.
- **Rules blocked a read/write** — rules deny everything not strictly type-safe
  and signed-in (or a capability GET of a device doc by its exact hash id). A
  save failing on `createTransaction` with a money mismatch normally means a
  service's `pricePaise` in Firestore isn't an integer — re-add the service
  from the Developer console.

## Roadmap (this 10-part build)

1. ✅ Foundation: structure, shell, design system, Firebase wiring
2. ✅ Single-code sign-in: one shared code, anonymous auth, full access, shop record bootstrap
3. ✅ Today's dashboard: live Firestore figures, recent transactions, quick services
4. ✅ Transaction system: record-sale modal, inline services, payment
   methods, offline queue, dashboard wiring, flat single-shop data model
   (v0.8.0 moved sale entry into a dialog; v0.9.0 split the history browser
   out of it).
5. ✅ **Daily ledger (v0.9.0, this build):** `ledger.html` — one business
   day at a time with date navigation, debounced search, payment/status
   filters, edit, delete, mark-due-as-paid, day totals, cursor pagination
   and a read-only state for closed days. Monthly reports are **not** part
   of this part.
6. Customers
7. Expenses
8. Daily closing — *the `days/{dateKey}` register and the day-open rules
   already shipped in v0.9.0; the close action itself is still to come.*
9. Reports & service statistics
10. Settings polish, security-rule tests, deployment hardening
    (v0.7.0 added the trusted-device registry; per-IP brute-force rate
    limiting remains a **Firebase App Check** recommendation for production).