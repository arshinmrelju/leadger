# Realtime Database rules

`database.rules.json` is **strict JSON with exactly one permitted key,
`rules`** — the Realtime Database rules parser accepts no comments, not
even a `"//"` key. Both of these are rejected at load time, which fails the
whole `firebase deploy` before Firestore or hosting are touched:

```jsonc
{ "//": "comment", "rules": { ... } }   // 2:3: Expected 'rules' property.
{ "rules": { "//": "comment" } }       // 3:11: Expected '{'.
```

So this file is deliberately comment-free and the reasoning behind it
lives here. Keep the two in step when either changes.

`firestore.rules` is a different format — a real DSL, where `//` comments
are legal — so do not move prose there to make room here.

## What lives where

This database no longer decides access to anything. The two access codes,
the proof-of-code records, the trusted-browser registry and the admin
grants all moved to Cloud Firestore, **next to the money**, because
Firestore rules can read a document (`accessGrants/{uid}`) while Realtime
Database rules cannot — a rule language that cannot see the trust record
cannot enforce it.

| Path | Now | Why |
| --- | --- | --- |
| `settings/security` | denied | held the **plaintext shop code**; the hash is Firestore `securitySecrets/shop` |
| `settings/admin` | denied | held the **plaintext admin code**; the hash is Firestore `securitySecrets/admin` |
| `settings/general` | denied | moved to Firestore `shop/general` |
| `enrollments` | denied | moved to Firestore `enrollments/{uid}`, compared against `securitySecrets` |
| `devices` | denied | the `tokenHash` registry is dead; trust is `accessGrants/{uid}` |
| `admins` | denied | there is no separate admin collection; it is `accessGrants/{uid}.role` |
| `expenses` | read-only, `auth != null` | still here — see the known gap below |

The old paths are kept **denied on purpose rather than deleted**, so a
stale deploy still pointing at an older ruleset fails closed instead of
quietly re-opening the shop to every anonymous Firebase user. Their data
can be deleted once the new rules are live and the shop has been running
correctly on Firestore for a while.

## Known gap: expenses

`expenses/{dateKey}/{expId}` is still in this database, and `auth != null`
is the strongest condition this rule language can express — so **any
anonymous Firebase user can READ the shop's expenses.**

Mitigating factors, stated plainly rather than as reassurance:

- `.write` is `false`, so expenses cannot be created, changed or removed
  from a client at all.
- No rule anywhere trusts this data for money arithmetic; the daily ledger
  recomputes its totals from the Firestore rows.
- An attacker still has to know this project id, which is only in the
  shipped bundle and in any URL they already had.

It is not a fix. The fix is to move expenses into Firestore so they sit
behind the same `trusted()` gate as the ledger, and that is the next
planned step.
