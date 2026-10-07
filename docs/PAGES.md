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
| Owner Console | `admin.html` | `/admin.html` | admin | 315 |
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

**Actions** — `#newTxnBtn` `NEW TRANSACTION` ·
`#refreshBtn` `Refresh` · `#emptyRecordBtn` `Record a sale` (receipt scanning lives
inside the sale dialog as `#saleScanBtn`, plus <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>)

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

### 🛡️ Owner Console — `admin.html`

`initAppShell({ requireAdmin: true })` + `grantAdminAccess()` · **one sidebar link, under
Management** · **on the app shell**

A shell page, like every other protected screen: it inherits the sidebar, top bar, user
chip, install controls and mobile tab bar, and `renderOwnerConsole(ctx)` in `js/admin.js`
paints into `#mainContent`. What is its own is the paper — the four sections sit on the
same receipt sheet as the dashboard's, using its stat cards, its stamp and its tear edge,
so a rupee looks the same on both pages. The sections are chips inside the receipt, not
sidebar links: the sidebar's one "Owner console" entry already says where you are, and
day-close never sits one tap from sale entry. The HTML is a 315-line shell.

| Chip | What it answers | Reads |
|---|---|---|
| **Money** | What did we take today, and how is this month going? | today's summary · this + last month's day heads · the month's expenses |
| **Month** | Which days are in this month, and where is it out of step? | the month's day heads · the month's expenses |
| **Day** | Is this day finished, and does its head add up? | the day's head · the day's summary with its recent sales · head + rows for the integrity check |
| **Shop** | What do we sell, and who may open the ledger? | service catalog · access grants |

**Money** opens with a greeting over the month's hero net, with the change
against last month's collections underneath it, then today's tiles and the
month-to-date tiles. The hero is a deep-green card: in-hand vs spent glass
cells and a 14-day collections sparkline (amber today, blue recorded days,
ghosts for gaps), all drawn from heads already in hand. Below them sit the collection mix (cash / UPI / card /
due with each one's share) and the spending overview: a donut of the month's
expenses by their own category field with budget-style bars. Every figure is
folded off day heads rather than summed from sales, so it costs one query per
month instead of a read per sale; the hero's delta costs one extra cached
month of heads, and the mix, donut and day-sales list cost nothing at all.

**Month** opens with a day-X-of-D progress bar (pure calendar math), then
lists the month's recorded days as one row per day — date block,
sales, state, taken, spent and net — with the month's own total as a closing
row, and the days with nothing on them called out by name. A finished
month is scanned whole (`monthBounds(yearMonth).days`): stopping at the last day with
something on it would declare the rest of the month outside the ledger, which is the
exact gap the screen exists to find. Future months cannot be walked into.

**Day** takes any date, opens or closes it, lists that day's sales newest
first (the summary already carries the rows, so the list is free), and
checks it. Closing is enforced by
`firestore.rules`, not by the UI: every sale write against a closed day is refused.
Re-opening is how a sale typed against the wrong day gets fixed. The integrity check
recomputes the day's counters from its rows and offers a one-step repair when the
difference is exactly one sale wide. The current browser's own grant uid is tracked
separately from the rolled-over business day, so midnight refreshes today's figures
without moving an owner who is deliberately reading yesterday.

**Shop** edits the catalog inline (name, rate, archive/restore) and manages the browsers
allowed to open the ledger: revoke, restore, remove.

Two things were removed rather than moved, because the console now works differently
without them:

- **Free plan usage.** The counters and their "clear today's" button are gone; the quota
  layer still counts and still raises its own exhausted banner, but the owner is not
  asked to manage a meter's read budget.
- **All data.** It read every recent sale in the app. The Money and Month tabs read the
  same figures off day heads, which is what the shop actually wants to know.

**Every expenses figure is guarded.** `fetchTodaySummary()` leaves `expensesPaise` at `0`
when the Realtime Database read fails and marks it with `expensesUnavailable`, because
"nothing was spent" and "we could not read" are otherwise the same number. The console
prints `Not read` and withholds the net rather than showing one that is too high by
exactly the amount nobody could read.

Non-admins get an `Owner console locked` gate; an unauthenticated visitor gets
`Sign in with the owner's Google account to get in.`

**Dues stop at the month, on purpose.** Money reports what is due today and what is due this
month, both folded off day heads. There is no all-time outstanding total: Firestore charges
one read per matching document, so that figure would cost a read per unpaid sale in the
shop's history, exceed the app's 50-read daily budget on a shop with more than roughly fifty
open dues, and leave the screen showing an error instead of a number. Every unpaid sale from
any month is on the Sales screen.

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
| Scan a receipt | `js/image-receipt.js` | `#saleScanBtn` inside the sale dialog · ⌘⇧N |
| Confirm | `js/app.js` | every destructive action |
| Toast | `js/app.js` | everything |

### Scan a receipt — one bill, one list

The scan modal has four stages and never sends the shopkeeper back to re-type what the bill already
said. `#scanStage` holds them and `setStage()` moves between them; the reading is in
`js/receipt-items.js`, the drawing in `js/image-receipt.js`.

| Stage | Shown when | Elements |
|---|---|---|
| Drop zone | the modal opens, and after `Pick different` | `#dropZone` `#fileInput` |
| Preview | a photo is chosen | `#previewWrap` `#previewImg` `#previewMeta` `#analyzeBtn` `#pickDifferentBtn` |
| Analyzing | a read is in flight | `#analyzingWrap` |
| Review | **more than one line was read** | `#reviewWrap` and the rows below |

| Review element | Purpose |
|---|---|
| `#reviewTitle` `#reviewSub` | how many lines were read, and whether they add up to the bill's own total |
| `#scanItems` | one `.scan-item` per line: `[data-line-total]`, qty + rate inputs, its own service search |
| `[data-cands]` | the closest catalog services for a line nothing matched, one tap each |
| `[data-add-service]` | add the name the bill printed as a new service, at the bill's rate |
| `.scan-item-remove` | a reading the shopkeeper does not believe |
| `#scanDate` `#scanDayHint` | the business day for **every** line, future days refused |
| `#scanMethodRow` | one payment method for the whole bill |
| `#scanTotalPreview` | the sum of the lines |
| `#reviewSaveBtn` | writes the batch; disabled until every line has a service and a rate |
| `#reviewRereadBtn` `#reviewOtherBtn` | keep this bill / scan a different one |
| `#reviewMsg` | why a line was not booked, and which lines are still waiting |

A **single-line** bill skips the review and opens the record-a-sale form instead, prefilled. When
that line's name is not in the catalog, the form shows `#scanSuggest` — the name as it was read,
the closest services as chips, `Add it as a service`, `Hide`. Choosing any service hides it.

### Record a sale — fields

| Field | Element | Notes |
|---|---|---|
| Business day * | `#txnDate` | `type="date"`, `#bizDayHint`; future days refused |
| Service * | `#servicePick` | ARIA combobox from `js/service-picker.js` |
| — scan suggests | `#scanSuggest` | only when a scan named something the catalog lacks: `#scanSuggestName`, `#scanSuggestChips`, `#scanSuggestAdd`, `#scanSuggestHide` |
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