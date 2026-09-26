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

**Admin console gate (v0.10.0).** `admin.html` is no longer part of the public
app. The **Management → Admin** link is gone from the dashboard, the ledger and
the history browser, and the console now needs a **second code** of its own:

- The shop code (`settings/security`) still opens the ledger exactly as before.
- The admin code (`settings/admin`, a separate secret, never readable by any
  client) is what unlocks the console. Presenting it writes an admin-scope
  `enrollments/{nonce}` proof, which the rules compare against
  `settings/admin` server-side, and only a correct code can mint the
  `admins/{uid}` grant that the console checks.
- **Device management is admin-only now.** Revoking, restoring and removing a
  browser is refused by the rules to any device without that grant — so the
  shop code alone can never be used to lock the owner out of their own shop.
  (Restoring *another* browser also works for the first time; previously only a
  device's owner could flip its own `active` flag back.)
- A grant is permanent for the browser that earned it: it survives reloads and
  cache clears, and the console marks admin-capable browsers in the device
  list. A browser can always drop its own grant, and any admin can drop
  another's.
- Sales, the service catalog, expenses and the day-close register are
  unchanged — the employee still does all of that with the shop code alone.

> **Deploy required:** `firebase deploy --only firestore`. The rules add
> `settings/admin`, the `scope` field on enrollments, the `admins/{uid}`
> collection and the admin gate on `devices`. Until those land, the console
> unlock will be refused and device management will follow the old rules.

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

The Developer console (`admin.html`) is behind the **admin code** described
above (it is not linked from the public navigation), and covers:

- **Trusted devices**: revoke/restore/remove any browser, with admins marked.
- **Services**: add, rename, re-price, archive/restore the catalog, and re-run
  the default service seed as a repair tool (see
  [Default service catalog](#default-service-catalog)).
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
> + `__name__` DESC). v0.10.0 adds the admin gate: `settings/admin` (a second,
> never client-readable code), the `scope` field on `enrollments/**`, the
> `admins/{uid}` grant collection, and `isAdmin()` in front of every device
> revoke/restore/remove. Existing `members/`, `pendingMembers/` and old
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
├── admin.html            Developer console (admin code; not in the nav)
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
│   ├── service-catalog.js  Default service seed list (pure data) — no Firebase
│   ├── admin.js          Developer console rendering
│   ├── shell.js          Shared protected-page bootstrap (chip, date, keys)
│   ├── sale-form.js      Shared "Record a sale" modal (openSaleForm/onSaleRecorded)
│   ├── app.js            Shared init, toasts, modals, shell behavior, errors
│   └── utils.js          Money (paise), dates (Asia/Kolkata), validation
├── tests/
│   ├── ledger.mjs        Node test suite for money/validation/day-view/catalog helpers
│   └── module-graph.mjs  Every named import must resolve to a real export
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
| `settings/admin` | **never readable or writable by clients** | seeded with the default admin code on first use; only an admin-scope enrollment may compare against it |
| `enrollments/{nonce}` | denied | one-time proof-of-code, `scope: 'shop' \| 'admin'` (single use, owner-burn) during first-time device setup and console unlock |
| `devices/{tokenHash}` | signed-in devices (list); unauthenticated GET **by unguessable hash id** (the auto-login gate) | enrollment creates; owner heartbeats/renames; **revoke/restore/remove require an admin grant** |
| `admins/{uid}` | the device itself (`get`); list is admin-only | created only from an unused `scope: 'admin'` enrollment; never updated; deleted by an admin or by the device itself |
| `transactions/{txnId}` | code-signed-in devices | create: signed-in, server-validated (`createdBy == uid`, money checks). update/delete: signed-in **and the day is still open** |
| `services/{serviceId}` | code-signed-in devices | signed-in; `delete` always denied (archive via `active=false`) |
| `expenses/{expId}` | code-signed-in devices | (writing arrives in a later build) |
| `days/{dateKey}` | code-signed-in devices | absent document = day is **open**; a present document is a closed day, written once and never updated or deleted |

A transaction document: `serviceId`, `serviceName`, `quantity`,
`rate` (paise/unit), `total` (`quantity * rate` — re-verified server-side),
`paymentMethod` (`cash`/`upi`/`card`/`due`), `status` (`paid`/`pending`,
derived from method), `customerId`/`customerName` (customer name optional),
`dateKey`, `createdAt`/`updatedAt`, `createdBy`/`updatedBy`.

### Default service catalog

`services/{serviceId}` is the only source of truth for the catalog — every
screen reads it through `fetchServices()`, and nothing renders from a file.
`js/service-catalog.js` is the list a shop starts from, and it is **seeded
automatically**: the protected-page shell calls `ensureCatalogSeeded()`
before the first render, so a fresh shop finds the services already on its
dashboard instead of an empty quick-services grid. The Developer console
keeps an **Add default services** button for the same job, as a repair tool.

- **Idempotent, and safe on several devices at once.** An entry is covered
  either by NAME (case- and spacing-insensitive, so anything the shop typed
  in by hand is left alone) or by its deterministic SEED ID (slug + FNV-1a
  hash of the name, e.g. `svc_seed_photocopy_1x2y3z4`). Two devices seeding
  at once therefore write the *same* document: the second write is refused
  by the rules, because an update must preserve `createdAt`/`createdBy`, and
  it is counted as "already there" rather than treated as a failure. A
  renamed default keeps its seed id, so renaming one is never undone.
- **Archived services count as present.** The rules never allow a delete
  (removal is `active: false`), so a deliberately archived default is not
  resurrected as a second live row. Use **Restore** on its row instead.
- **₹0 by default.** Rates are the shop's own, and a wrong number seeded here
  would silently pre-fill the rate box on every future sale. Set them on the
  console rows.
- **Best effort, never fatal.** A failed catalog read is logged and swallowed
  so the page still works; the console can seed by hand.
- **Groups are a `sortOrder` band, not a field.** The rules pin the service
  keys with `hasOnly([...])`, so a `category` field would be rejected without
  a rules change. Instead each group owns a `sortOrder` band (100s = printing,
  200s = computer/DTP, 300s = government/certificates, 400s = online, 500s =
  photo), which `fetchServices()` already sorts by — so the counter's groups
  appear in order in every picker, dropdown and grid.
- **`code` is the tile.** The two-letter code is the badge on the quick grids
  (the UI truncates it to two characters), so it is a display shortcut, not an
  inventory code.
- **Duplicates are merged.** A real rate card repeats jobs across headings —
  building tax, possession, income and legal paperwork under both
  "government/certificate" and "local/property"; DTP, printing and scanning
  under both "printing" and "computer/DTP". Those are the same billed job, so
  each is listed once, under the group the counter reads it from first.

The quick grids are deliberately short (12 on the dashboard, 16 in the sale
dialog) and say how many more there are. The service **picker** in the record-a
sale dialog holds the whole catalog: it is a listbox combobox
(`js/service-picker.js`) that searches on name, tile code and rate, arranges the
matches under their `sortOrder` group headings, takes the keyboard
(arrows/Home/End/Enter/Esc/type-ahead-free Tab), and offers to add what was typed
when nothing matches. The menu is pinned to the viewport rather than the dialog
body, because the dialog body scrolls and would clip an in-flow dropdown.

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

The Developer console has its own second code: **`TRUSTXADMIN`**, seeded into
`settings/admin`. It is never accepted by the shop sign-in, and the shop code is
never accepted by the console — they are compared against different documents.

**How it works:**

1. **First visit (`login.html`):** enter the code. The app signs in
   anonymously (a real Firebase session) and writes a one-time
   `enrollments/{nonce}` proof-of-code with `scope: 'shop'`. The rules only
   accept it if the submitted code equals the code stored in
   `settings/security`. It then creates an **active** `devices/{tokenHash}` doc
   — where `tokenHash` is the SHA-256 of a fresh 256-bit random token kept
   **only in the browser's IndexedDB** (never in localStorage, URLs, or the
   network) — and burns the enrollment.
2. **Later visits (`index.html`):** the trust gate hashes the stored token
   and reads `devices/<hash>` **before any session exists** (the id itself
   is the proof — it is unguessable). If the doc exists and is `active`, the
   app signs in automatically and you land on the dashboard. No code typed.
3. **Revoked or removed browsers** land on `login.html` and must enter the
   code again; re-verification issues a brand-new token. `/transactions`,
   `/dashboard`, `/ledger` and `/admin` are trust-gated too, so a revoked
   session is redirected even if the browser kept an old anonymous session.
4. **Unlocking the console (`/admin`):** the console is not linked from the
   navigation, so you open it by typing the path. It asks for the **admin
   code**, writes a `scope: 'admin'` enrollment, and on success mints an
   `admins/{uid}` grant. That grant is what `isAdmin()` checks in the rules,
   and it is remembered for this browser from then on.
5. **Managing devices:** the Developer console → **Trusted devices** can
   revoke / restore / remove any browser. Those three actions require the
   admin grant, which is the "what if the shop code leaks?" valve: an admin
   revokes everything, then re-verifies on the trusted computer. Without the
   admin code, a stolen shop code cannot lock the owner out.

- **No accounts, no members.** Everyone who proves the shop code gets full
  access to the *ledger*; the only capability split is the Developer console's
  admin grant. `members/` and `pendingMembers/` from earlier builds are gone;
  old data in those paths is unreachable.
- **Honest trade-offs:** the shared code is see-and-share (anyone who gets it
  can enroll a device and record sales), and a device credential is only as
  safe as the browser profile holding it. The codes are never stored or
  transmitted in plaintext in the app source past the default seed;
  brute-forcing enrollment is limited by single-use nonces and short-lived
  anonymous sessions, and hardened further with Firebase **App Check**
  (recommended for production). Keep the codes private among the people who
  use the shop.
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
  onReady, onDayChange, requireAdmin })` — renders the user chip, day rollover,
  global keys, and ensures the shop record exists. `requireAdmin: true`
  additionally resolves the console's admin grant into `ctx.isAdmin`.
- The Developer console lives in `js/admin.js`:
  `renderAdminPage(ctx)` — renders the admin-code unlock card when
  `ctx.isAdmin` is false, otherwise service maintenance, the trust registry and
  the all-data browser.
- Sign-in and trusted devices live in `js/auth.js`:
  `SHOP_CODE` / `ADMIN_CODE` (the seeded defaults), `isCorrectCode()`,
  `isCorrectAdminCode()`, `signInAnonymous()`,
  `ensureShopRecord()` (silently creates `settings/general` and seeds
  `settings/security` + `settings/admin` on first use), `getGeneral()`,
  `enrollDevice({ label })` (server-verified, stores the credential),
  `checkTrustedDevice()` (capability read of `devices/<hash>`),
  `listTrustedDevices()`, `revokeDevice/restoreDevice/removeDevice`,
  `updateDeviceLastUsed(hash)`, `generateDeviceToken()`, plus the
  IndexedDB helpers (`loadDeviceCredential`, `saveDeviceCredential`,
  `clearDeviceCredential`) and `canStoreDeviceCredential()`.
- The console gate lives in `js/auth.js` too:
  `checkAdminAccess()` (is this browser an admin?), `grantAdminAccess(code)`
  (exchange the admin code for an `admins/{uid}` grant),
  `revokeAdminAccess()` (drop this browser's own grant) and
  `listAdminGrants()` (which browsers are admins).
- Ledger data lives in `js/ledger.js`:
  `fetchTodaySummary(dateKey?)`, `fetchServices({ includeInactive })`,
  `createTransaction({ serviceId, serviceName, quantity, rate, paymentMethod,
  customerName, dateKey })` (rate in rupees, stored as paise),
  `createService({ name, price, code, sortOrder, serviceId })`,
  `seedDefaultServices({ onProgress })` (writes the catalog entries the shop is
  missing), `ensureCatalogSeeded()` (the best-effort, auto-run form the page
  shell calls), `updateService(serviceId, { name, price, active })`,
  `fetchTransactions({ dateKey, limit })`,
  `fetchExpenses({ dateKey, limit })`, `flushPendingWrites()`,
  `normalizeTxn()`, `isNetworkError(err)`.
- The service seed list is pure data in `js/service-catalog.js` (no Firebase
  import, so the tests require it directly): `SERVICE_CATALOG`,
  `SERVICE_CATALOG_GROUPS`, `SERVICE_SEED_PREFIX`, `DEFAULT_SERVICE_PRICE_RUPEES`,
  `catalogKey(name)`, `catalogSeedId(name)` and
  `findMissingCatalogServices(existing)`.
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
   or by re-seeding — there is intentionally no in-app setter. The admin code
   works the same way in the `admin` document, seeded `TRUSTXADMIN`.
- **"That admin code is not recognised" / the console stays on the unlock
  card** — either the code is wrong, or `firebase deploy --only firestore` has
  not shipped the v0.10.0 rules yet (`settings/admin` missing, `admins/**`
  denied).
- **"The ledger rejected that request" on revoke / restore / remove** — those
  three actions need an admin grant. Unlock the console in a browser that has
  one, or create `admins/{uid}` by hand in the Firebase console (uid = the
  browser's anonymous sign-in uid).
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
- **The seed button reads "Defaults added"** — the catalog already covers every
  default, which is what you want. An archived service counts as present, so a
  default you deliberately archived will *not* reappear; use **Restore** on its
  row instead.
- **Quick services are empty on the dashboard** — the catalog read failed, so
  the automatic seed was skipped (`ensureCatalogSeeded()` logs the reason to the
  browser console and never blocks the page). Check the console for the error:
  the usual cause is rules that predate the services collection, fixed with
  `firebase deploy --only firestore`. You can also seed by hand from the console.
- **A seed stopped part-way** — the connection dropped or a write was refused.
  The services already written are kept, and the next sign-in adds only what is
  still missing.

## Roadmap (this 10-part build)

1. ✅ Foundation: structure, shell, design system, Firebase wiring
2. ✅ Single-code sign-in: one shared code, anonymous auth, full access, shop record bootstrap
3. ✅ Today's dashboard: live Firestore figures, recent transactions, quick services
4. ✅ Transaction system: record-sale modal, inline services, payment
   methods, offline queue, dashboard wiring, flat single-shop data model
   (v0.8.0 moved sale entry into a dialog; v0.9.0 split the history browser
   out of it).
5. ✅ **Daily ledger (v0.9.0):** `ledger.html` — one business
   day at a time with date navigation, debounced search, payment/status
   filters, edit, delete, mark-due-as-paid, day totals, cursor pagination
   and a read-only state for closed days. Monthly reports are **not** part
   of this part.
6. ✅ **Admin gate (v0.10.0, this build):** the console leaves the public
   navigation and takes its own code; `admins/{uid}` grants and admin-only
   device management.
7. Customers
8. Expenses
9. Daily closing — *the `days/{dateKey}` register and the day-open rules
   already shipped in v0.9.0; the close action itself is still to come.*
10. Reports & service statistics
11. Settings polish, security-rule tests, deployment hardening
    (v0.7.0 added the trusted-device registry; per-IP brute-force rate
    limiting remains a **Firebase App Check** recommendation for production).