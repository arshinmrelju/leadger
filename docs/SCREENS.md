# Screenshots

The repository has **no** screenshots of the running app, and the README does not pretend
otherwise. This file is how to add real ones. The canonical list lives in the README's
[Interface Preview](../README.md#screens) section — this is the working procedure for it.

---

## ⚠️ Read this before capturing

`firebase.json` sets `hosting.public` to `"."`, and its `ignore` list does **not** include
`docs/`. Anything you put in `docs/screens/` will be **published to the live deployment**.

Add this to the `ignore` array in `firebase.json` first:

```jsonc
"ignore": [
  "…",
  "docs/**"
]
```

And capture against a **scratch Firebase project**, never the live one. Screenshots of a working
shop contain real service names, real totals, and real customer names.

---

## The 16 shots

| # | File | How to reach the state |
|---|---|---|
| 01 | `01-gateway.png` | `index.html` |
| 02 | `02-signin.png` | `login.html` |
| 03 | `03-dashboard.png` | `dashboard.html`, with today's sales present |
| 04 | `04-dashboard-empty.png` | a fresh business day |
| 05 | `05-calendar.png` | `calendar.html`, a month with recorded, closed, missing and future days |
| 06 | `06-ledger.png` | `ledger.html` — rows, filters, totals |
| 07 | `07-ledger-closed.png` | the same day after **Close day** |
| 08 | `08-history.png` | `transactions.html` in **All time** scope, grouped by day |
| 09 | `09-sale-form.png` | ⌘N with the service picker open |
| 10 | `10-receipt-ocr.png` | ⌘⇧N, drop a real receipt photo, capture mid-analysis |
| 11 | `11-console-money.png` | `admin.html` → 💵 Money |
| 12 | `12-console-month.png` | `admin.html` → 📅 Month, with the missing days called out |
| 13 | `13-console-day.png` | `admin.html` → 🗓️ Day |
| 14 | `14-console-shop.png` | `admin.html` → 🛒 Shop |
| 15 | `15-offline.png` | DevTools → Network → **Offline**, then navigate to a page not in the precache |
| 16 | `16-mobile-dashboard.png` | DevTools → 390 × 844, showing the bottom tab bar |

The numbering is deliberate: it sorts in capture order.

---

## 1 · A profile with a trusted grant

Every money page requires an enrolled browser, so screenshots must be taken **after** signing in.
The unauthenticated shell is just the login card.

Use a clean profile or a private window so you do not disturb a real shop's grant list, then sign
in with an account on the allowlist. The console labels the current browser *"this browser"*.

## 2 · Seed representative data

Via the Owner console (`admin.html`):

- **🛒 Shop → Add default services** writes the seeds at ₹0. **Set realistic rates on a
  handful first**, or every screenshot will show `₹0`.
- **💵 Money** and **📅 Month** are read-only. Record sales through **⌘N** on the dashboard instead,
  so the atomicity proof is exercised for real rather than faked with a seed script.
- Spread sales across several days, and include:
  - more than one payment method
  - at least one **due** sale left `pending`
  - at least one sale **backfilled** onto a past business day
  - at least one **closed** day
  - at least one day with **no entries at all**, so the calendar's catch-up panel is populated

## 3 · Capture

| Property | Value |
|---|---|
| Desktop | 1440 × 900 |
| Mobile | 390 × 844 — `css/mobile.css` replaces the sidebar with a bottom tab bar below 1024 px, so one width does not represent both layouts |
| Format | PNG, lossless — this is a ledger, and blurred digits undermine it |
| Colour profile | sRGB |
| Strip | EXIF, and any window chrome or OS taskbar |

The app is dark-first. Capture as-is; there is no light theme to fake.

### Offline shot

DevTools → Network → throttling → **Offline**, then reload. Verify the label reads `NO
CONNECTION` and **not** `NOT CACHED YET` — the second means the cache has not primed, so navigate
away and back first.

### After capture

Compress to ~1600 px wide, under ~300 KB each. WebP or PNG.

---

## Wiring them into the README

Drop them into the README's Interface Preview section, wrapped in `<details>` so a reader who does
not care about the pictures is not made to scroll past them:

```markdown
<details>
<summary><b>📸 Real screenshots</b></summary>

| Dashboard | Record a sale |
|---|---|
| ![Dashboard](docs/screens/03-dashboard.png) | ![Record a sale](docs/screens/09-sale-form.png) |

</details>
```

Every screenshot must correspond to the real page it is labelled with. A mock-up is worse than no
picture.

Keep `assets/readme-banner.svg` as the hero regardless — it is an SVG replica, it loads instantly,
and it never goes stale in a way that misrepresents the UI.

---

## Already available

| Asset | Use |
|---|---|
| `assets/readme-banner.svg` | Hero — a replica of the dashboard, used as-is |
| `assets/logo.svg` | App logo |
| `assets/icon-192.png`, `icon-512.png` | PWA icons — 192 and 512 px squares, too small to be useful as a preview |

`node tools/make-icons.mjs` regenerates the PNG icons from `assets/logo.svg` if the logo changes.
