# Pages & Overlays

Every page in [TrustX Ledger](https://github.com/arshinmrelju/leadger), and every modal that is not
a page. All eight pages are deployed at `https://trustxplpy.web.app` — verified **HTTP 200**.

Base URL: **`https://trustxplpy.web.app/`**

---

## Access levels

| Level | Meaning |
|---|---|
| `public` | Anyone can load it |
| `trusted` | Signed in **and** `accessGrants/{uid}.active == true` |
| `admin` | Trusted **and** `accessGrants/{uid}.role == "admin"` |

`trusted` and `admin` pages still serve their HTML to anyone — the gate is applied by
`js/auth.js` in the browser *and* by `firestore.rules` on every read and write. Hiding a page is
never the control; the rules are.

---

## Pages

| Page | File | Route | Access | Lines |
|---|---|---|---|---|
| System Gateway | `index.html` | `/` | public | 128 |
| Sign in | `login.html` | `/login.html` | public | 207 |
| Dashboard | `dashboard.html` | `/dashboard.html` | trusted | 713 |
| Calendar | `calendar.html` | `/calendar.html` | trusted | 538 |
| Daily Ledger | `ledger.html` | `/ledger.html?date=YYYY-MM-DD` | trusted | 746 |
| Transaction History | `transactions.html` | `/transactions.html[?date=YYYY-MM-DD]` | trusted | 623 |
| Developer Console | `admin.html` | `/admin.html` | admin | 161 |
| Offline Fallback | `offline.html` | `/offline.html` | public | 112 |

---

### 🏠 System Gateway — `index.html`

`data-page="index"` · title `TrustX Ledger` · no Firebase import.

- Live date stamp in `#receiptTimeDisplay`, computed in-page from `new Date()`
- One action: `.btn-receipt-pay` → `login.html`, label `SIGN IN WITH GOOGLE`
- Registers the service worker at module load — **deliberately the first page a shop ever
  sees**, so the installed app is already cached before anyone signs in

---

### 🔐 Sign in — `login.html`

`data-page="login"` · title `Sign in · TrustX Ledger`

Imports: `firebase.js`, `pwa.js`, `auth.js`.

| Element | Purpose |
|---|---|
| `#googleSignInBtn` | `Sign in with Google` → `signInWithGoogle()` then `enrollBrowser()` then redirect |
| `#authAlert` / `[data-alert-msg]` | `role="alert"` region for every failure |
| `#receiptTimeDisplay` | live date |

**Auto-forward:** on boot, `getAccessGrant()` is read; an `active === true` grant goes straight
to `dashboard.html` without showing the button.

**Query reasons** rendered distinctly:

| `?reason=` | Message |
|---|---|
| `signedout` | You have been signed out. |
| `revoked` | This browser's access was revoked. Sign in with Google to continue. |
| `not-enrolled` | This browser is not set up on this shop yet. Sign in with Google to continue. |

**Preflight:** `isConfigured()` false → warning banner, button disabled.

---

### 📊 Dashboard — `dashboard.html`

`data-page="dashboard"` · the PWA `start_url` and `id`.

Imports `setLoading`, `formatINR`, `formatKolkataLong`, `formatKolkataTime`, `escapeHtml`,
`todayKolkata`, `fetchTodaySummary`, `fetchServices`, `isNetworkError`, `reportError`,
`initAppShell`, `openSaleForm`, `onSaleRecorded`, `openScanReceiptModal`.

**Eight stat cards** — `statBlock(icon, svg, label, valueId, cardClass, emphasis, noteId)`:

| Card | Value element | Source |
|---|---|---|
| Revenue | `#statRevenue` (+ `#revenueNote`) | `dayHeads/{today}.counters.grossPaise` |
| Count | `#statCount` | `counters.txnCount` |
| Cash | `#statCash` | `counters.cashPaise` |
| UPI | `#statUpi` | `counters.upiPaise` |
| Card | `#statCard` | `counters.cardPaise` |
| Due | `#statDue` | `counters.duePaise` |
| Expenses | `#statExpenses` | RTDB `expenses/{today}/*` — read-only |
| Net | `#statNet` | `gross − expenses`, coloured against zero |

**Recent transactions** — `#recentCount`, `#recentBody`, `#recentFooter`, `#refreshBtn`, plus a
`View history` link to `transactions.html`.

**Quick services** — `#quickGrid`, up to 12 tiles; a tap opens the sale form pre-filled with that
`serviceId`. `#quickAddBtn` → `Add services`.

**Actions** — `#scanReceiptBtn` `SCAN RECEIPT` · `#newTxnBtn` `NEW TRANSACTION` ·
`#refreshBtn` `Refresh` · `#emptyRecordBtn` `Record a sale`

**Shell hooks** — `onReady` registers `onSaleRecorded()`; `onDayChange` reloads on Kolkata
midnight.

---

### 📅 Calendar — `calendar.html`

`data-page="calendar"`

Imports `fetchMonthHeads`, `isNetworkError`, `dayHeading`, `initAppShell`, `openSaleForm`,
`onSaleRecorded`, and from `js/calendar.js`: `DAY_STATUS`, `WEEKDAY_LABELS`, `buildGrid`,
`monthBounds`, `monthLabel`, `currentYearMonth`, `shiftMonth`, `monthTotals`, `missedDays`,
`dayCellLabel`, `dateKeyFromSearch`, `writeDateToSearch`.

| Element | Purpose |
|---|---|
| `#calPrev` | Previous month |
| `#calMonthLabel` | month label, `aria-live="polite"` |
| `#calNext` | Next month — disabled at the current month |
| `#calThisMonth` | This month |
| `#calRefresh` | `Refresh this month` → `loadMonth({ force: true })` |
| `#calGrid` | `role="grid"`, `aria-label="Month at a glance"` |
| `#calSummary` | month gross · sale count · days recorded · days to fill |
| `#calMissed` | catch-up panel, `MISSED_LIST_LIMIT = 8` |
| `.cal-cell[data-day]` | link to `ledger.html?date=` + optional `[data-add-day]` `+` |

Four statuses — **recorded · closed · nothing entered · not yet**. A day with no sales is drawn
as an outline, never as `₹0`.

---

### 📒 Daily Ledger — `ledger.html`

`data-page="ledger"` · `PAGE_SIZE = 100` · `SEARCH_DEBOUNCE_MS = 250`

| Element | Purpose |
|---|---|
| `#ledgerDayLabel` | `dayHeading(dateKey)` |
| `#ledgerCloseBtn` / `#ledgerReopenBtn` | Close day / Reopen day — toggled by state |
| `#ledgerRecordBtn` | `Record sale` — disabled while closed |
| `#ledgerClosed` | closed banner |
| `#ledgerPrev` / `#ledgerDate` / `#ledgerNext` / `#ledgerToday` | day navigation; date lives in the URL |
| `#ledgerSearch` | debounced 250 ms over service + customer |
| `#ledgerMethod` | All methods / Cash / UPI / Card / Due |
| `#ledgerStatus` | All statuses / Paid / Pending |
| `#ledgerRefresh` | `Refresh` |
| `#ledgerBody` / `#ledgerTotals` | rows and day totals from the rows |
| `#ledgerLoadMore` / `#ledgerMoreText` | cursor paging |

Row actions come from `txnActionButtons(t, { closed })`.

---

### 🧾 Transaction History — `transactions.html`

`data-page="transactions"` · `LIMIT = 500`

| Element | Purpose |
|---|---|
| `#histCount` `#histTotal` `#histPaid` `#histDue` | four stat cards |
| `#histSub` | scope subtitle |
| `#histSearch` | debounced 160 ms |
| `#histDate` | pin to one day; writes the URL |
| `#histMethod` | payment filter |
| `#histTodayBtn` / `#histAllBtn` / `#histResetBtn` | scope switching |
| `#histRefreshBtn` | `Refresh` |
| `#histBody` / `#histFooter` | rows grouped under day headings; footer states when capped |
| `#histEmptyBtn` | `Record a sale` when a pinned day is empty |
| `#newTxnBtn` | `New transaction`, pre-filled with the pinned day |

Scope is derived from the URL: a `date` param means **day**, otherwise **all time**.

---

### 🛡️ Developer Console — `admin.html`

`data-page="admin"` · `initAppShell({ requireAdmin: true })` · **not in the sidebar nav**

The HTML is a 161-line shell; `renderAdminPage(ctx)` in `js/admin.js` renders everything.

| Card | Controls |
|---|---|
| **Services** | `Add default services` (`#seedSvcBtn`) with a missing-seeds preview · inline rename (`[data-svc-name]`) · re-price (`[data-svc-price]`) · archive/restore |
| **Free plan usage** | `#quotaBars` · `#quotaResetNote` · `#quotaResetBtn` `Clear today's counter` |
| **Trusted browsers** | `#devicesList` with `[data-grant-action="revoke\|restore\|remove"]`; the current browser is marked |
| **All data** | `#dataDate` · `#dataDayBtn` `Day` · `#dataAllBtn` `All recent` · `#dataRefreshBtn` · `#dataTxnBody` / `#dataTxnFooter` · `#dataExpBody` / `#dataExpFooter` |
| **Day integrity** | recompute vs head counters; offers a one-step repair when the difference is one sale wide |

Non-admins get `Developer console is locked`.

---

### 📴 Offline Fallback — `offline.html`

`data-page="offline"` · `class="auth-body"` · served by the service worker when a navigation
misses the cache and there is no connection.

- Tag `NO CONNECTION`; `#offlineState` shows `NOT CACHED YET` or `NO CONNECTION`
- `YOUR DATA — SAFE ON THIS DEVICE`
- Exits: `Today's takings` → `dashboard.html`, `Day ledger` → `ledger.html`
- `#retryBtn` → `window.location.reload()`

---

## Overlays — modals, not pages

| Overlay | Module | Opened by |
|---|---|---|
| Record a sale | `js/sale-form.js` | `#newTxnBtn` · ⌘N · `+` on a calendar day · a quick-service tile |
| Edit a sale | `js/txn-actions.js` | row `edit` button |
| View receipt photo | `js/txn-actions.js` | row `receipt` button |
| Mark paid / Delete | `js/txn-actions.js` | row `paid` / `delete` buttons |
| Scan a receipt | `js/image-receipt.js` | `#scanReceiptBtn` · ⌘⇧N |
| Confirm | `js/app.js` | every destructive action |
| Toast | `js/app.js` | everything |

### Record a sale — fields

| Field | Element | Notes |
|---|---|---|
| Business day * | `#txnDate` | `type="date"`, `#bizDayHint`; future days refused |
| Service * | `#servicePick` | ARIA combobox from `js/service-picker.js` |
| — inline add | `#newServiceName` `maxlength=80` · `#newServiceRate` | `Add "<query>" as a service` |
| Quantity | `#qtyInput` | `min=1 max=100000 step=1` |
| Rate ₹ | `#rateInput` | text + `inputmode="decimal"`, parsed to paise |
| Total | derived | `quantity × rate`, never typed |
| Payment method * | radio group | cash · upi · card · due |
| Customer | `#customerInput` | `maxlength=120`, optional |

### Row actions — `txnActionButtons(t, { closed })`

| `data-act` | Visible when | Disabled when |
|---|---|---|
| `receipt` | `t.hasReceipt` | **never** — reads work on a closed day |
| `paid` | `paymentMethod === "due" && status === "pending"` | day closed |
| `edit` | always | day closed |
| `delete` | always | day closed |

---

## Keyboard map

| Keys | Action | Registered in |
|---|---|---|
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>N</kbd> | Record a sale | `js/shell.js` — every protected page |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> | Scan a receipt | `js/image-receipt.js` at module load |
| <kbd>Esc</kbd> | Close the topmost overlay, else the sidebar | `js/app.js`, document level |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Home</kbd> <kbd>End</kbd> <kbd>Enter</kbd> <kbd>Tab</kbd> | Service picker navigation and commit | `js/service-picker.js` |
| <kbd>Enter</kbd> / <kbd>Space</kbd> | Open the file picker from the drop zone | `js/image-receipt.js` |

---

## Sidebar

| Item | Target |
|---|---|
| Dashboard | `dashboard.html` |
| Transactions | `transactions.html` |
| Daily Ledger | `ledger.html` |
| Calendar | `calendar.html` |
| Customers | `data-coming` → *"This module is coming in a later build."* |
| Expenses | `data-coming` — same |
| Reports | `data-coming` — same |

The active item is resolved from `location.pathname`, falling back to `body[data-page]`
(`js/app.js`).

**Mobile** (`css/mobile.css`, below 1024 px) replaces the sidebar with a bottom tab bar:
**Today · Day · Sales · Month**.

---

## PWA shortcuts

From `manifest.webmanifest`:

| Shortcut | URL |
|---|---|
| Today | `/dashboard.html` |
| Transactions | `/transactions.html` |
| Calendar | `/calendar.html` |
| Day ledger | `/ledger.html` |

`id` and `start_url` are both `/dashboard.html`; `scope` is `/`.