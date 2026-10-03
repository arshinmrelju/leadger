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

**Evening entry, backfill and day closing (v0.13.0).** The shop fills its
ledger at the end of the day, so a sale can belong to a business day that is
not today, and a day that was never written up has to be visible rather than
quietly missing. This build adds a month calendar, lets a sale be filed
against an earlier day, and lets a day be closed (and reopened).

- **Calendar (`calendar.html`).** A Monday-first month grid showing every day
  as *recorded*, *closed*, *nothing entered* or *not yet*. A day with no sales
  is drawn as an outline, never as ₹0 — "nothing was entered here" and
  "nothing was sold here" are different facts, and only one of them is a gap
  in the books.
- **The `+` on a day opens the sale form for that day** without leaving the
  calendar, so catching up a missed week is a sequence of short taps. The
  "Still to fill in" panel names the first few missed days and counts the
  rest.
- **One read per month.** The grid is built from `dayHeads` alone — a single
  ranged query (`orderBy dateKey`, `startAt`/`endAt` on the month's two
  bounds) costing at most 31 document reads however many sales each day
  holds. The result is cached for 60 s fresh / 10 min stale.
- **Business day on every sale.** The sale dialog opens with a **Business
  day** field defaulted to today. Choosing an earlier day files the sale
  against that day — the day's own counters move with it, in the same atomic
  batch, and the form names the day out loud so a backfill is never mistaken
  for tonight's takings. Future days are refused by the UI and by the rules.
- **Backfilled rows are marked.** A sale typed up later keeps the `createdAt`
  of the moment it was entered, so its time column alone would read like an
  evening sale. Those rows carry a `Backfilled` badge beside the time.
- **Close and reopen a day.** Closing writes `state`, `closedAt` and
  `closedBy` onto the day head without touching its counters; reopening
  removes the closing stamps and leaves the money exactly where it was. While
  a day is closed, every sale write, edit and delete is refused by
  `firestore.rules` no matter what the UI allows.
- **Scanned receipts keep their own date.** The receipt scanner now fills the
  form in for the day printed on the receipt (when that day is in the past)
  instead of filing it under today and asking for a correction afterwards.
- **Deep links.** `ledger.html?date=YYYY-MM-DD` and
  `transactions.html?date=YYYY-MM-DD` open on one business day, and switching
  day or scope keeps the URL honest — including clearing it when the page
  goes back to all-time.

> **v0.13.0** adds `js/calendar.js` (pure grid logic, no Firebase import, so
> the whole month is unit-tested), `calendar.html`, `css/calendar.css`, a
> `Business day` field in the sale dialog, and an open ↔ closed transition in
> `firestore.rules`.

**Google Sign-In with server-enforced allowlist (v0.12.0).** The shop no
longer uses access codes. Instead, users sign in with Google, and a
Firestore allowlist (`allowedUsers/{email}`) controls who may access the
shop and what role they hold. The allowlist is written only by the bootstrap
tool (`tools/bootstrap-access.mjs`) using the Admin SDK — no client can read
or write it.

- **Google Sign-In.** Users click "Sign in with Google" on the login page.
  Firebase verifies the Google credential and issues a Firebase session.
- **Two roles.** The `shop` role opens the ledger. The `admin` role unlocks
  the Developer console and can manage trusted browsers. Roles are assigned
  per email in the allowlist.
- **Trust is a revocable grant.** A successful sign-in writes an
  `enrollments/{uid}` proof and mints an `accessGrants/{uid}` record. Every
  money rule calls `trusted()`, which reads that grant — so revoking it takes
  effect on the very next request without touching the session.
- **The allowlist is the owner credential.** Only emails in the allowlist
  can sign in. An admin email gets an admin grant; a shop email gets a shop
  grant. The shop role alone can never self-promote to admin.
- **A proof must carry the account's *own* address.** The rules compare the
  email in `enrollments/{uid}` against `request.auth.token.email` and look
  the allowlist up by that token claim — never by a string the browser
  merely claims. Signing in with Google is open to anybody, so without this
  an outsider could enrol by typing the owner's address.
- **The allowlist's role is the ceiling.** An entry marked `admin` may prove
  either scope (so the owner can hold shop trust on one machine and unlock
  the console from it); an entry marked `shop` may only ever prove `shop`, so
  a shop user cannot request `admin` and be believed.
- **Revoked browsers recover by signing in again.** Reactivation requires a
  valid allowlist entry, so a revoked admin comes back as shop, never as admin.
- **The old RTDB trust paths are denied.** `settings/security`,
  `settings/admin`, `enrollments`, `devices` and `admins` are all closed in
  `database.rules.json`; their data can be deleted once the new rules are
  live. See `DATABASE-RULES.md` for the full mapping.

> **First-time setup required:** run `node tools/bootstrap-access.mjs --key
> <service-account.json> --add owner@gmail.com --role admin` to add the first
> admin before anyone can log in.

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
- **Closed days are read-only.** When a `dayHeads/{dateKey}` document is `closed` the
  page shows a "day is closed" notice, disables the row actions, and the rules
  reject the write server-side regardless of what the UI allows.
- **Pagination is prepared** with cursor paging (`orderBy createdAt DESC,
  __name__ DESC` + `startAfter`), so a busy day degrades into "Load more"
  instead of a silent truncation. The transaction count in the footer comes
  from a count aggregate, so it is right even while only one page is loaded.
- **Responsive:** a desktop table that becomes one card per sale below
  760 px, using the same markup.

**Google Sign-In login (v0.12.0).** Users sign in with their Google account.
The first time a browser signs in with an authorised Google account it
becomes a **trusted device**: the Firebase session persists locally and
skips the sign-in on every later visit — until someone revokes it from the
Developer console. The allowlist lives **server-side** (`allowedUsers`):
Firestore rules verify enrollment, so no client can read or modify the
list of authorised accounts.

The Developer console (`admin.html`) is behind the **admin role** described
above (it is not linked from the public navigation), and covers:

- **Trusted browsers**: revoke/restore/remove any browser, with admins marked.
- **Services**: add, rename, re-price, archive/restore the catalog, and re-run
  the default service seed as a repair tool (see
  [Default service catalog](#default-service-catalog)).
- **All data**: transactions (per day or most recent) with totals, plus the
  expenses list — a read-only back-office view. The interactive day book now
  lives in `ledger.html`; this panel is unchanged.

The dashboard, the record-a-sale dialog and the daily ledger stay
operational, backed by the offline queue.

**Google Sign-In (v0.12.0).** Users sign in with their Google account.
A Firestore allowlist (`allowedUsers/{email}`) controls who may access
the shop and what role they hold (shop or admin). The allowlist is written
only by the bootstrap tool (`tools/bootstrap-access.mjs`) using the
Admin SDK — no client can read or write it. The trust model is unchanged:
a successful sign-in mints an `accessGrants/{uid}` record, and every
money rule calls `trusted()`, which reads that grant.

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

> **Deploy required:** run `firebase deploy --only firestore,database` first — the
> rules now add the trust registry (`allowedUsers/**`, `enrollments/**`,
> `accessGrants/**`) and allow the auto-login gate to read a grant doc by its
> uid before any session exists. v0.9.0 additionally opens
> `transactions` to validated `update`/`delete` while the day is open, adds
> the `dayHeads/{dateKey}` close register, and extends the composite
> index behind the ledger's cursor paging (`dateKey` ASC + `createdAt` DESC
> + `__name__` DESC). v0.10.0 adds the admin gate: the `role` field on
> `accessGrants/**`, the `scope` field on `enrollments/**`,
> and `isAdmin()` in front of every device
> revoke/restore/remove. Existing `members/`, `pendingMembers/` and old
> `settings/security` documents are no longer used (denied by the rules) but
> can stay in place. Every already enrolled browser re-verifies once after
> the trust-registry deploy.
>
> **v0.11.0** replaced the old trust layer. The codes are no longer in the
> bundle: they were created once by the owner via `tools/bootstrap-access.mjs`
> and stored as SHA-256 hashes in Firestore `securitySecrets/{shop,admin}`,
> which no client can read. A code entry wrote `enrollments/{uid}` and minted
> `accessGrants/{uid}`; every money rule calls `trusted()`, which reads that
> grant. The `settings/security`, `settings/admin`, `enrollments`, `devices`
> and `admins` RTDB paths are denied, and the service catalog and shop
> settings moved to Firestore so the sale rules can verify them.
>
> **v0.12.0** replaces access codes with Google Sign-In. The allowlist
> (`allowedUsers/{email}`) is created and managed by the owner via
> `tools/bootstrap-access.mjs`. A Google sign-in writes `enrollments/{uid}`
> with the user's email and mints `accessGrants/{uid}`; every money rule
> calls `trusted()`, which reads that grant. The `securitySecrets`,
> `settings/security`, `settings/admin`, `enrollments`, `devices`
> and `admins` paths are denied. **Allowlist entries must be
> created before anyone can log in** — see [Access](#access).

## Project structure

```
/
├── index.html            Entry point (trusted-device gate / auth routing)
├── login.html            Shop-code sign in (enrolls this browser as trusted)
├── dashboard.html        App shell, today's figures, quick services
├── calendar.html         Month grid: which days are recorded, which are missing
├── ledger.html           Daily ledger (one business day, editable, day totals)
├── transactions.html     Transaction history (all time or a single day)
├── admin.html            Developer console (admin code; not in the nav)
├── css/
│   ├── style.css         Design tokens + core components
│   ├── forms.css         Inputs, selects, chips, auth page, business-day field
│   ├── dashboard.css     Stat cards, quick grids, entry panel
│   ├── transactions.css  Sale modal, history browser, totals
│   ├── ledger.css        Ledger toolbar, table, mobile card transform
│   ├── calendar.css      Month grid, day statuses, catch-up panel
│   ├── admin.css         Developer console rows/actions
│   └── responsive.css    Desktop-first, mobile fallback
├── js/
│   ├── firebase.js       Firebase config, lazy SDK load, offline persistence
│   ├── auth.js           Code sign-in, trusted-device enrollment/check, shop bootstrap
│   ├── ledger.js         Firestore day heads + sales, RTDB services/expenses
│   ├── calendar.js       Pure month-grid logic (bounds, statuses, totals) — no Firebase
│   ├── day-heads.js      Pure day-head counters + per-method split — no Firebase
│   ├── day-ledger.js     Pure day-view logic (date shift, filter, totals) — no Firebase
│   ├── service-catalog.js  Default service seed list (pure data) — no Firebase
│   ├── admin.js          Developer console rendering
│   ├── shell.js          Shared protected-page bootstrap (chip, date, keys)
│   ├── sale-form.js      Shared "Record a sale" modal (openSaleForm/onSaleRecorded)
│   ├── app.js            Shared init, toasts, modals, shell behavior, errors
│   └── utils.js          Money (paise), dates (Asia/Kolkata), validation
├── tests/
│   ├── ledger.mjs        Node test suite for money/validation/day-view/catalog/day-head helpers
│   ├── calendar.mjs      Month grid, totals, missed days, backfilled-row marking
│   └── module-graph.mjs  Every named import must resolve to a real export
├── package.json          Scripts (npm test), no runtime deps
├── assets/
│   ├── logo.svg
│   └── favicon.svg
├── firestore.rules       Firestore security rules — the money only
├── firestore.indexes.json
 ├── database.rules.json   Realtime Database rules — expenses only; old paths denied
├── firebase.json         Hosting + Firestore + Realtime Database deploy config
├── .env.example
└── README.md
```

The Firebase modular SDK is loaded from a **pinned CDN version (12.18.0)**
via an import map in each page. There is no bundler, no npm install, and no
build step to run the app.

## Data model (single shop)

One shop, one Firebase project, **two databases**. There is no `shops/`
path in either. Everything the money does not need to sit next to is in
the Realtime Database:

| Realtime Database path | Read | Write |
|---|---|---|
| `settings/general` | **denied** | **denied** — moved to Firestore `shop/general` |
| `settings/security` | **denied** | **denied** — old shop code path; the allowlist is in Firestore `allowedUsers` |
| `settings/admin` | **denied** | **denied** — old admin code path; the allowlist is in Firestore `allowedUsers` |
| `enrollments/{uid}` | **denied** | **denied** — moved to Firestore `enrollments/{uid}` |
| `devices/{tokenHash}` | **denied** | **denied** — the `tokenHash` registry is dead; trust is `accessGrants/{uid}` |
| `admins/{uid}` | **denied** | **denied** — there is no separate admin collection; it is `accessGrants/{uid}.role` |
| `expenses/{dateKey}/{expId}` | any signed-in user | **denied** — see `DATABASE-RULES.md` for why this is the one gap |

The old paths are denied rather than deleted so a stale deploy fails closed.
Their data can be removed once the shop has been running on the new model
for a while.

The money is in Firestore, and it is the only thing there:

| Firestore path | Read | Write |
|---|---|---|
| `allowedUsers/{email}` | **denied** | **denied** — the Google-account allowlist; only the bootstrap tool (Admin SDK) can write |
| `enrollments/{uid}` | **denied** | **denied** — one-time proof-of-authorisation; the rules check the email against `allowedUsers` |
| `accessGrants/{uid}` | owner or admin | owner (self-service) or admin (full management) — the trusted-browser registry |
| `dayHeads/{dateKey}` | trusted devices | created on a day's first sale; counters move **only** in the same atomic batch as a sale, edit or delete, and the rules re-check the delta. Absent document = day is **open**; a `closed` day is written once and never reopened |
| `dayHeads/{dateKey}/transactions/{txnId}` | trusted devices | create: trusted, server-validated (`createdBy == uid`, money checks, head delta). update/delete: trusted **and the day is still open** |

### Which database holds what

**Cloud Firestore holds the money and nothing else.** The business day is
the partition, so a day is a single document and its sales are a
subcollection of that document:

- `dayHeads/{dateKey}` — the day: `state` (`open`/`closed`),
  `openedAt`/`openedBy`, optional `closedAt`/`closedBy`, and `counters`
  (`txnCount`, `grossPaise`, `cashPaise`, `upiPaise`, `cardPaise`,
  `duePaise`, `collectedPaise`).
- `dayHeads/{dateKey}/transactions/{txnId}` — the sales recorded that day.

Two things follow from that, and both are deliberate:

- **A sale and the day's totals are one atomic batch.** The rules prove the
  head moved by exactly that sale's `amounts` split, so a sale cannot land
  without the day following it, and an edit or delete cannot leave the day
  counting money that is gone. The pure arithmetic behind this lives in
  `js/day-heads.js` and is unit-tested against the rules' own invariant.
- **The dashboard reads one document instead of a whole day of sales.** If
  the head is missing or its counters fail the consistency check, the day's
  rows are folded instead, so the numbers on screen are never worse than
  they were before the day was given a head.

**Realtime Database holds only expenses.** Shop settings, the service
catalog, the Google-account allowlist and the trust registry all moved to
Cloud Firestore, next to the money, because Firestore rules can read a
document (`accessGrants/{uid}`) while Realtime Database rules cannot — a
rule language that cannot see the trust record cannot enforce it. The RTDB
paths for the old model are kept denied on purpose; see `DATABASE-RULES.md`.

One consequence worth knowing: the catalog is in Firestore alongside the
transactions, so the sale rules verify via `get()` that the `serviceId`
exists, is active, and matches the `serviceName` the client sent. A sale
cannot be booked against a service that has been deleted or deactivated.

A transaction document: `txnId`, `serviceId`, `serviceName` (snapshot),
`quantity`, `rate` (paise/unit), `total` (`quantity * rate` — re-verified
server-side), `amounts` (the per-method split the head counters are
advanced by), `paymentMethod` (`cash`/`upi`/`card`/`due`), `status`
(`paid`/`pending`, derived from method), `customerId`/`customerName`
(customer name optional), `dateKey`, `createdAt`/`updatedAt`,
`createdBy`/`updatedBy`.

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
  photo, 600s = bill payment/utility), which `fetchServices()` already sorts by —
  so the counter's groups appear in order in every picker, dropdown and grid.
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
   (`apiKey`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`),
   and set `databaseURL` to the Realtime Database URL from the same page.
5. Enable the sign-in method the app needs:
   **Authentication → Sign-in method → Google**.
   The free Spark plan is enough — **no Cloud Functions are required**.

The config object is not complete without `databaseURL`, and the app needs
it for more than the catalog: the trusted-device registry, the shop and
admin codes, the Developer console and expenses all live in the Realtime
Database. A wrong or missing URL leaves the ledger working (sales are
Firestore) but the login gate, the quick-services grid and the expense
panel degraded, with the reason in the browser console.

Firebase **client configuration is not a secret** — it goes in the frontend
by design. All real security lives in `firestore.rules`, `database.rules.json` and
Authentication.
Never paste service-account or admin private keys into frontend code.

The app detects the placeholders and stays in a safe "setup needed" mode
until a real config is present, so nothing is ever exposed by misconfiguration.

## Add your project to the Firebase CLI

```bash
firebase login
firebase use --add        # select or create the project, e.g. alias "default"
```

You can also put the project id in `.env` (see `.env.example`).

## Deploy to Firebase Hosting, Firestore & the Realtime Database

```bash
firebase deploy --only hosting
firebase deploy --only firestore     # Firestore rules + indexes
firebase deploy --only database      # Realtime Database rules
```

## Access

### First-time setup (one-time, by the shop owner)

The app ships with **no allowlist entries**. Before anyone can log in, add
the first admin:

```bash
node tools/bootstrap-access.mjs --key <service-account.json> --add owner@gmail.com --role admin
```

Other commands:

```bash
node tools/bootstrap-access.mjs --key <sa.json> --add worker@gmail.com --role shop
node tools/bootstrap-access.mjs --key <sa.json> --list                      # who has access
node tools/bootstrap-access.mjs --key <sa.json> --remove worker@gmail.com   # revoke access
node tools/bootstrap-access.mjs --key <sa.json> --list-grants              # trusted browsers
node tools/bootstrap-access.mjs --key <sa.json> --revoke <uid>             # lock a browser out
```

### How it works

1. **First visit (`login.html`):** click "Sign in with Google". The app
   opens a Google OAuth popup, verifies the credential, and writes a one-time
   `enrollments/{uid}` proof with the user's email. The rules compare the
   email against `allowedUsers/{email}` — the allowlist is unreadable by
   any client.
2. **On success:** the rules mint an **active** `accessGrants/{uid}` record.
   Every money rule calls `trusted()`, which reads that grant, so access is
   decided by the server on every request.
3. **Later visits:** the browser keeps its Google session. If the grant is
   still active, the app signs in automatically and lands on the dashboard.
   No sign-in needed.
4. **Revoked or removed browsers** land on `login.html` and must sign in
   again. Reactivation requires a valid allowlist entry, so a revoked
   admin comes back as shop, never as admin.
5. **Unlocking the console (`/admin`):** the console is not linked from the
   navigation. It checks whether the signed-in user's email maps to an
   admin role in the allowlist. If so, the browser's grant is promoted to
   `role: 'admin'`. That grant is what `isAdmin()` checks in the rules.
6. **Managing browsers:** the Developer console → **Trusted browsers** can
   revoke / restore / remove any browser. Those actions require the admin
   grant, which is the "what if a Google account is compromised?" valve: an
   admin revokes everything, then re-verifies on the trusted computer.

- **No accounts, no members.** Everyone in the allowlist gets full
  access to the *ledger*; the only capability split is the Developer console's
  admin grant.
- **Honest trade-offs:** Google Sign-In is see-and-share (anyone who gets
  access to an authorised Google account can sign in and record sales). The
  allowlist is never stored or transmitted in plaintext in the app source.
  Enrollment is limited by the email comparison happening server-side, and
  hardened further with Firebase **App Check** (recommended for production).
  Keep the allowlist private among the people who use the shop.
- **Sign out** returns to the login screen. Because the browser stays
  trusted, it signs back in automatically — to stop that on a given computer,
  revoke it from the Developer console (or clear the site data).
- **Known limitation — no App Check yet.** Without it, the allowlist check is
  server-side but still reachable by anyone who knows the endpoint. Enabling
  App Check is the cheapest real improvement and is worth doing for
  production.

## Tests

Pure money/validation helpers (`js/utils.js`) and the pure day-view helpers
(`js/day-ledger.js`) are unit-tested with Node's built-in runner — no
installs needed:

```bash
npm test
# or
node --test tests/ledger.mjs tests/calendar.mjs
```

`day-ledger.js` is deliberately kept free of any Firebase import so the
daily-ledger behaviour is testable in Node: date shifting across month,
year and leap-day boundaries, the search/payment/status narrowing, the
per-method day totals, cursor-page merging, and the Asia/Kolkata entry
time.

`tests/calendar.mjs` does the same for `js/calendar.js`, and for the reason
that matters most here: a calendar that is a day out, or that calls a day
with no sales "recorded", is a wrong thing to show a shopkeeper. It pins
the 42-cell Monday-first grid, month bounds across leap years, the
"nothing entered is not a zero-sales day" distinction, future days never
counting as missing, a head whose counters do not add up refusing to
produce a rupee figure, and the `Backfilled` marking of a row entered on a
later day than the one it belongs to.

`tests/module-graph.mjs` guards the wiring instead, because there is no
bundler to catch it: it walks the real import graph (HTML entry scripts
AND JS → JS imports) and asserts that

1. every named import resolves to a name the target module actually
   exports — a missing export is a link-time error that kills the whole
   module graph in the browser, which is how every protected screen once
   sat on its spinner; and
2. no module exports a name that nothing imports — the mirror image. Dead
   exports are the cheapest kind of rot in a bundler-free app, so they
   have to fail a test rather than quietly accumulate. `tests/` counts as
   a real consumer, so helpers kept for their unit tests stay.

There is no lint, type-check or build step, and no CI. `npm test` and
`node --check` on each module are the whole safety net, so run both after
touching a file.

### The security rules

Rules are behaviour, not configuration, so they get their own check:

```bash
npm run test:rules
```

`tools/rules-check.mjs` starts a throwaway Firestore emulator, points it at a
test-only copy of `firestore.rules`, and drives the day-head scenarios through
it — that a sale cannot land unless the day's counters move by exactly that
sale, that the payment buckets must re-derive the total, that `total` must be
`quantity x rate`, that a settled due sale moves no money, that closing a day
pins the closing stamps, that a day with nothing on it cannot be closed, that
editing or deleting a sale on a closed day is refused, and that a day may be
reopened without its counters moving. It starts and stops the emulator itself,
so it is not part of `npm test`.

Two things to know when reading its output:

- **It substitutes `request.time`.** The public REST API cannot express
  `FieldValue.serverTimestamp()`, so the script substitutes a fixed literal
  for that one expression and leaves every clause carrying the day's
  arithmetic exactly as written.
- **`BADRQ` and `SKIP` are not passes, and they say so.** The emulator
  evaluates a whole rules file with a fixed expression budget, and this one is
  over it: several scenarios are refused because the evaluation itself errors
  rather than answering `false`. Those are reported as `BADRQ — the rules
  failed to evaluate, not a verdict`, never as a green refusal, and where a
  scenario depends on state that could not be established the harness reports
  `SKIP` and names the case. Eight cases are in that state today, all of them
  pre-existing money paths (`accept a sale that moves the head by exactly that
  sale` and its siblings); they are honest gaps in the harness, not verdicts.
- **The close is planted out of band so the reopen rules can be judged.**
  Closing a day through the rules is one of the cases that trips the
  expression ceiling, which would leave every reopen case testing an *open*
  day. The harness therefore writes the closed head with the emulator's admin
  token (`Bearer owner`, which bypasses rules the way the Admin SDK does) and
  then makes every assertion as the shop user, with the real rules in force.
  That is how `accept reopening a closed day` gets a genuine verdict — and how
  a bug in the harness itself was caught: the "reopen that also moves the
  counters" case was passing a fixed counter set that could coincide with what
  the day already held, so the reopen it called a counter move was not one.

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
- The day head's own arithmetic lives in `js/day-heads.js` (no Firebase
  import): `emptyCounters`, `splitAmounts`, `amountsFromDoc`,
  `isCounterSetValid`, `stepCounters`, plus the frozen `DAY_STATE`,
  `PAYMENT_METHODS` and `COUNTER_FIELDS`. It is the client-side twin of
  the rules, and the test suite checks the two agree.
- Day-scoped reads/writes live in `js/ledger.js`:
  `fetchDayPage({ dateKey, pageSize, cursor })`, `countDayTransactions`,
  `fetchDayState`, `updateTransaction(txnId, dateKey, patch)`,
  `markTransactionPaid(txnId, dateKey)`, `deleteTransaction(txnId, dateKey)`.
  The mutations take a `dateKey` because a sale is addressed by its day,
  not by a flat id.
- UI helpers live in `js/app.js`:
  `toast(msg, type)`, `confirm({...})`, `setLoading(button, bool)`.
  `confirm()` escapes its `message` for you — pass `htmlMessage` instead
  when the body genuinely needs markup, and only with pre-escaped values
  interpolated into it.
- Logged-in pages bootstrap through `js/shell.js` `initAppShell({ onReady,
  onDayChange, requireAdmin })` — renders the user chip, day rollover,
  global keys, and ensures the shop record exists. `requireAdmin: true`
  additionally resolves the console's admin grant into `ctx.isAdmin`.
- The Developer console lives in `js/admin.js`:
  `renderAdminPage(ctx)` — renders the locked card when
  `ctx.isAdmin` is false, otherwise service maintenance, the trust registry and
  the all-data browser.
- Sign-in and the trust gate live in `js/auth.js`:
  `signInWithGoogle()`, `enrollBrowser({ label })` (writes the
  `enrollments/{uid}` proof with the user's email), `getAccessGrant()`,
  `touchAccessGrant()`, `requireAccess()` (the protected-page gate),
  `listAccessGrants()`, `revokeGrant/restoreGrant/removeGrant`,
  `grantAdminAccess()`, `ensureShopRecord()` (creates Firestore
  `shop/general` on first trusted load) and `getGeneral()`.
- The console gate lives in `js/auth.js` too:
  `grantAdminAccess()` (exchange this account's admin allowlist entry for an
  `accessGrants/{uid}` admin grant — the rules accept the proof only when the
  signed-in account's own verified address carries the admin role, so it
  doubles as the "am I an admin?" question, since no client can read the
  allowlist) and `listAccessGrants()` (the trust registry). Whether the
  browser is *already* an admin needs no call: `js/shell.js` reads this
  browser's own grant once and hands it to the page as `ctx.isAdmin`.
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
  `isNetworkError(err)`.
- The service seed list is pure data in `js/service-catalog.js` (no Firebase
  import, so the tests require it directly): `SERVICE_CATALOG`,
  `SERVICE_CATALOG_GROUPS`, `SERVICE_SEED_PREFIX`, `DEFAULT_SERVICE_PRICE_RUPEES`,
  `catalogKey(name)`, `catalogSeedId(name)` and
  `findMissingCatalogServices(existing)`.
- Global uncaught errors are logged and surface as a friendly toast — raw
  Firebase errors are never shown to users.

## Keyboard conventions

- `Esc` closes any open modal or the mobile sidebar.
- `Ctrl/⌘+N` opens the "Record a sale" dialog from anywhere in the app.

## Troubleshooting

- **"Firebase is not configured yet."** — Replace the `YOUR_*` values in
  `js/firebase.js` (see *Connect Firebase* above).
- **"That Google account is not authorised for this shop."** — the email
  you signed in with is not in the Firestore `allowedUsers` allowlist, where
  the **document ID is the email address itself**. If this shop has never
  been set up, **no allowlist entries exist yet**: add the first admin with
  `node tools/bootstrap-access.mjs --key <service-account.json> --add owner@gmail.com --role admin`,
  then redeploy the rules (`firebase deploy --only firestore`).
  - *Every* account hitting this at once, including your own, usually means
    the entry is under the wrong document ID rather than that the address is
    unknown. Check with `--list` and re-run `--add` for that address: the tool
    writes the ID the rules look for and sweeps away a stale hashed entry from
    an older version.
  - The address must match `request.auth.token.email` byte for byte, so keep
    it lower-case. The tool does that for you; a hand-edited entry may not.
- **The console stays on the locked card** — the signed-in Google account
  does not have an admin role in the allowlist. Sign in with an admin
  Google account, or add your email as admin with
  `node tools/bootstrap-access.mjs --key <sa.json> --add you@gmail.com --role admin`.
- **"Realtime Database is not reachable."** — `databaseURL` in `js/firebase.js`
  is wrong, or the database has never been created for the project. The ledger
  still records sales (they are Firestore), but expenses are unavailable until
  it points at the right database.
- **"The ledger refused that sale"** — the rules denied the write and
  Firestore does not say which clause failed, so check the two things that
  actually cause it, in this order:
  1. **The business day is closed.** Look at `dayHeads/{today's dateKey}`
     in Firestore; if `state` is `closed`, no sale can be recorded against
     it. The sale form now says so outright instead of failing.
  2. **The service was archived or renamed.** A sale must name a service
     that exists, is `active: true`, and whose `name` matches the document
     on disk exactly (see `validTransactionDoc` in `firestore.rules`).
     Rename it in the Developer console and the stale name in the picker
     is refused.
- **"The ledger refused that change" on revoke / restore / remove** — those
  three actions need an admin grant. Sign in with an admin Google account,
  or mint one with
  `node tools/bootstrap-access.mjs --key <sa.json> --grant <uid> --role admin`.
- **`auth/configuration-not-found`** — the Firebase project behind your web
  API key isn't available to the browser SDK. Confirm the key in
  `js/firebase.js` is the real Web API key for your project, the right
  project is selected, and **Authentication → Sign-in method → Google**
  is enabled, then redeploy.
- **A trusted browser suddenly asks to sign in again** — either someone
  revoked/removed it from the Developer console, or the browser's site data
  (and so the Google session) was cleared.
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
  the usual cause is Realtime Database rules that were never deployed, fixed
  with `firebase deploy --only database`, or a `databaseURL` in `js/firebase.js`
  that does not match your project. You can also seed by hand from the console.
- **A seed stopped part-way** — the connection dropped or a write was refused.
  The services already written are kept, and the next sign-in adds only what is
  still missing.

## Roadmap (this 10-part build)

1. ✅ Foundation: structure, shell, design system, Firebase wiring
2. ✅ Single-code sign-in: one shared code, anonymous auth, full access, shop record bootstrap (superseded by v0.12.0 Google Sign-In)
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
9. ✅ **Daily closing + backfill (v0.13.0):** `calendar.html` — a month grid
   that shows which days are recorded and which are still missing, read from
   `dayHeads` in one ranged query per month. Every sale can be filed against
   an earlier business day, days can be closed and reopened, and the close is
   enforced by `firestore.rules` rather than by the buttons being hidden.
10. Reports & service statistics
11. Settings polish, security-rule tests, deployment hardening
    (v0.7.0 added the trusted-device registry; v0.12.0 replaced access
    codes with Google Sign-In; per-IP brute-force rate
    limiting remains a **Firebase App Check** recommendation for production).
