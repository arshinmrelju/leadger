# TrustX Ledger — Documentation

Deep-dive reference for [TrustX Ledger](https://github.com/arshinmrelju/leadger). The root
[`README.md`](../README.md) is the showcase; these files are the reference manual.

| Document | What is in it |
|---|---|
| [`PAGES.md`](PAGES.md) | Every page, overlay and route — controls, data sources, keyboard map |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Module graph, layering, data flow, why two databases |
| [`DATA-MODEL.md`](DATA-MODEL.md) | Every Firestore and Realtime Database path, field by field |
| [`SECURITY.md`](SECURITY.md) | The access chain, every rule function, validation layers, known gaps |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | Local setup, tests, the rules harness, every tool script |
| [`SCREENS.md`](SCREENS.md) | How to capture the real screenshots the README needs |

---

## Before you add screenshots

`firebase.json` sets `hosting.public` to `"."` and its `ignore` list does **not** cover
`docs/`. Anything placed in `docs/screens/` is therefore **published to the live deployment**.

Add this to the `ignore` array in `firebase.json` before committing real screenshots:

```jsonc
"ignore": [
  "…",
  "docs/**"
]
```

Screenshots of a working shop contain real service names, real totals and real customer
names. Capture against a **scratch project**, not the live one.

---

## Repository at a glance

Counts are from `git ls-files` at `v0.13.1` — the **application**, excluding this `docs/` tree.

```text
89 tracked files
├─  9 HTML pages              3,634 lines
├─ 21 JS modules             14,016 lines
├─  9 CSS files               6,695 lines
├─  5 test files              4,194 lines   179 cases
├─  7 tool scripts
├─ 16 assets
├─ firestore.rules              923 lines   the money
├─ database.rules.json           55 lines   expenses + fail-closed legacy paths
├─ sw.js                        349 lines   cache v12 · 55 precached files
└─ package.json                            2 scripts · 0 dependencies · 0 build steps
```

Version `0.13.1` · Firebase JS SDK `12.18.0` · deployment <https://trustxplpy.web.app>