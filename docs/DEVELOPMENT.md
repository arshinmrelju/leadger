# Development

[TrustX Ledger](https://github.com/arshinmrelju/leadger) builds itself. There is nothing to
compile, bundle, or transpile — you edit a file, reload, and the change is there.

```bash
git clone https://github.com/arshinmrelju/leadger.git
cd leadger
npm test
```

That is the whole setup. `npm install` is not required, because `package.json` declares **zero**
dependencies.

---

## Scripts

| Script | Command | Needs |
|---|---|---|
| `npm test` | `node --test tests/ledger.mjs tests/calendar.mjs tests/module-graph.mjs` | nothing |
| `npm run test:rules` | `node tools/rules-check.mjs` | the Firebase CLI (it starts an emulator) |

---

## Tests

142 cases across three files.

| File | Lines | Covers |
|---|---|---|
| [`tests/ledger.mjs`](../tests/ledger.mjs) | 2 290 | paise arithmetic, `splitAmounts`, date keys, day-audit diagnosis and repair planning, OCR normalisation, catalog matching, quota arithmetic |
| [`tests/calendar.mjs`](../tests/calendar.mjs) | 416 | `buildGrid`, `monthBounds`, `monthTotals`, `missedDays`, `dayCellLabel` |
| [`tests/module-graph.mjs`](../tests/module-graph.mjs) | 557 | import edges — no cycles, no bare specifiers, import-map version consistency |

The pure-logic modules import nothing from Firebase, so Node can test them directly:

```js
import { splitAmounts } from "../js/day-heads.js";
```

`module-graph.mjs` is the one to read first when adding a module. It fails on:

- an import cycle
- a bare specifier that no import map resolves
- a Firebase version in an HTML import map that disagrees with another page

### Current status

```text
142 tests · 141 pass · 1 fail
```

The failing case is `tests/ledger.mjs:1221`, *"a day of legacy sales reads as in step to the client
and unusable to the rules"*, asserting `'bad-head' !== 'ok'`. It is a known failure in the
repository at `v0.13.1` and is reported here rather than hidden.

---

## Running the app

Any static file server from the project root works:

```bash
npx serve .          # or: python -m http.server 8080
```

Opening `index.html` over `file://` will **not** work — ES modules and service workers both require
an HTTP origin.

### Deploying

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # pick the project
firebase deploy --only firestore,database   # BOTH rule sets
firebase deploy --only hosting
```

Deploying only Firestore rules would leave the Realtime Database rules stale. Deploy both.

---

## Environment

| Variable | Used by | Purpose |
|---|---|---|
| `FIREBASE_PROJECT_ID` | `tools/bootstrap-access.mjs:219` | target project |
| `GOOGLE_APPLICATION_CREDENTIALS` | `tools/bootstrap-access.mjs:243` | service-account key path |
| `FIRESTORE_EMULATOR_HOST` | `tools/bootstrap-access.mjs:236` | aim at the emulator |
| `FIREBASE_PROJECT_ALIAS` | Firebase CLI | see `.env.example` |

`.env.example` is the template. The browser needs **no** environment variables — the Firebase web
config lives in `js/firebase.js` and the optional Gemini key in `js/ai-config.js`.

---

## Tool scripts

Seven scripts in [`tools/`](../tools). None run as part of `npm test`.

| Script | Lines | What it does |
|---|---|---|
| `bootstrap-access.mjs` | 501 | Manages `allowedUsers/{email}` — the allowlist the entire sign-in model rests on. Add, list, remove, change role, recover access. Uses the Admin SDK, because `firestore.rules:234-236` denies every read and write on that path. |
| `rules-check.mjs` | 904 | Behavioural check of the day-head rules against a throwaway Firestore emulator. Not in `npm test` — it needs the emulator. |
| `migrate-to-rtdb.mjs` | 160 | One-off migration of `settings`, `enrollments` and `devices` from Firestore to the RTDB. Kept for the record. |
| `cleanup-firestore.mjs` | 79 | Deletes the collections `migrate-to-rtdb.mjs` moved. Leaves `services` and `dayHeads` alone. |
| `make-icons.mjs` | 118 | Rasterises `icon-192`, `icon-512` and `icon-maskable-512` from `assets/logo.svg`. Needs headless Chrome or Edge; build-time only. |
| `test-browser-flow.mjs` | 115 | Drives the live sign-in and grant flow over the REST API, using `FIREBASE_CONFIG` from `js/firebase.js`. |
| `scan-old-txn.mjs` | 15 | Greps the pages and modules for a stray top-level `"transactions"` collection reference left over from before sales moved under their day head. |

### Typical first run

```bash
node tools/bootstrap-access.mjs list
node tools/bootstrap-access.mjs add you@example.com --role admin
```

Then sign in with that Google account on the deployed app. It enrols itself.

---

## Working on the rules

`firestore.rules` is 923 lines and is the security boundary. Three things to know before editing
it — all three are expanded in [`SECURITY.md`](SECURITY.md#three-places-the-rules-language-bit-back):

1. **A missing-property read raises rather than answering false.** Test `'field' in doc` *first*.
2. **There is no `startsWith`.** `matches` is anchored to the whole string.
3. **`existsAfter` only sees writes made earlier in the same batch.** Write order inside a batch is
   part of the contract.

After any change:

```bash
npm run test:rules
```

---

## Code conventions

| Convention | Where |
|---|---|
| ES modules everywhere; no bundler | every file |
| Firebase via a pinned import map (`12.18.0`) | every HTML page |
| Paise are integers; never a float for money | `js/utils.js`, `js/day-heads.js` |
| Business days are `Asia/Kolkata` date keys | `js/utils.js` — `kolkataDateKey`, `todayKolkata` |
| Pure logic stays free of Firebase and the DOM | `js/utils.js`, `js/day-heads.js`, `js/day-ledger.js`, `js/calendar.js`, `js/day-audit.js`, `js/service-catalog.js` |
| Comments explain **why**, especially around the rules | throughout |
| No `console.log` left in shipped code | `console.warn`/`console.error` only, and deliberately |

---

## Repository map

```text
70 tracked files
├─ index.html login.html offline.html          public gateway, auth, fallback
├─ dashboard.html calendar.html                workspace
├─ ledger.html transactions.html admin.html
├─ js/            20 modules · 11 284 lines
├─ css/            9 files  ·  5 400 lines
├─ assets/        10 files  (icons, logo, sound, banner)
├─ tests/          3 files  ·  3 263 lines
├─ tools/          7 files
├─ firestore.rules  923 lines
├─ database.rules.json  55 lines
├─ sw.js           342 lines
└─ docs/           this reference
```

---

## License

No `LICENSE` file is present. All rights reserved by default.
