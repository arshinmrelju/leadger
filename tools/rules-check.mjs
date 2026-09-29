/* Behavioural check of the day-head logic in firestore.rules.
   ---------------------------------------------------------------------------
   Not part of `npm test` — it needs a running emulator, so run it on its own:

     node tools/rules-check.mjs

   It starts a throwaway Firestore emulator, points it at a TEST-ONLY copy of
   firestore.rules, and drives the sale/head scenarios through it.

   Two emulator limits shape the harness, neither of which weakens what is
   being checked:

   1. `request.time` -> a literal. The public REST API cannot express
      `FieldValue.serverTimestamp()`, so the `field == request.time` pins are
      unreachable from a hand-built payload. Every other clause — the counter
      delta, the payment-bucket split, the author pinning, the day-open gate,
      the one-way close — runs unmodified.

   2. `updateMask` -> omitted. This emulator's REST bridge rejects any write
      carrying a mask, so each write resends the whole document instead. The
      rules only ever inspect `request.resource.data`, so a full-document
      write exercises exactly the same conditions; the harness just has to
      know what the document currently holds, and tracks that itself.
*/
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* No imports from bootstrap-access.mjs — the new Google auth system
   uses email-based allowlist entries, not hashed access codes. */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8123;
const PINNED = "2026-09-27T04:00:00.000Z";
/* Inside a write, `name` is the bare resource path; a full URL is rejected
   with "lacks projects at index 0". Only the request URL carries a host. */
const DOCS = "projects/trustxplpy/databases/(default)/documents";
const COMMIT = `http://127.0.0.1:${PORT}/v1/${DOCS}:commit`;
const UID = "u1";
const DAY = "2026-09-27";

/* The two allowed Google accounts, as the harness knows them. The client
   sends the email on sign-in and the operator plants the allowlist entries
   with the Admin SDK (tools/bootstrap-access.mjs). */
const EMAIL_SHOP = "shop@example.com";
const EMAIL_ADMIN = "admin@example.com";
const OUTSIDER = "u2";
const ADMIN_UID = "u3";
const PLAIN_UID = "u4";
const NOBODY = "u5";
const PROMOTED = "u6";

/* Which account each simulated browser is actually signed in as. The rules
   read the address off the ID token rather than off anything the client
   sent, so a harness that only supplies a uid is testing a weaker claim
   than the one production makes. This map is what lets the suite assert
   that one account cannot enrol by naming another's address. */
const ACCOUNTS = {
  u1: EMAIL_SHOP,               // the shop owner's main machine
  u2: "intruder@example.com",   // signed in with Google, not on the allowlist
  u3: EMAIL_ADMIN,              // the owner's second machine, enrolling fresh
  u4: EMAIL_SHOP,               // the same shop account, on another machine
  u5: "nobody@example.com",     // no grant, no entry, only here to be refused
  u6: EMAIL_ADMIN,              // the owner's machine already in the shop, on shop trust
};

let pass = 0;
let fail = 0;
let traceCount = 0;
const failures = [];

const COUNTER_KEYS = ["txnCount", "grossPaise", "cashPaise", "upiPaise", "cardPaise", "duePaise", "collectedPaise"];

/* --- wire value helpers ------------------------------------------- */
const str = (v) => ({ stringValue: v });
const num = (n) => ({ integerValue: String(n) });
const bool = (b) => ({ booleanValue: b });
const ts = (v = PINNED) => ({ timestampValue: v });
/* REST spells a map as {mapValue:{fields:{...}}}; a bare {fields:{...}} is the
   internal proto shape and is rejected as an invalid payload. */
const map = (o) => ({ mapValue: { fields: o } });

/* The emulator authenticates with a real (unsigned) JWT, not a bare string. */
function fakeJwt(uid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = { user_id: uid, sub: uid, iat: now, exp: now + 3600 };
  /* Google sign-in always carries a verified address, and the entire
     allowlist check hangs off this one claim. Seeded entries are planted
     under the address itself, exactly as tools/bootstrap-access.mjs does it
     in production, so the id the rules build and the id on disk are the
     same string. */
  claims.email = ACCOUNTS[uid];
  claims.email_verified = true;
  return [b64({ alg: "none", typ: "JWT" }), b64(claims), ""].join(".");
}

const counterFields = (c) => Object.fromEntries(COUNTER_KEYS.map((k) => [k, num(c[k])]));
const addCounters = (c, d) => Object.fromEntries(COUNTER_KEYS.map((k) => [k, c[k] + (d[k] || 0)]));

const ZERO = { txnCount: 0, grossPaise: 0, cashPaise: 0, upiPaise: 0, cardPaise: 0, duePaise: 0, collectedPaise: 0 };
const CASH_5000 = { txnCount: 1, grossPaise: 5000, cashPaise: 5000, upiPaise: 0, cardPaise: 0, duePaise: 0, collectedPaise: 5000 };
const CASH_6000 = { txnCount: 1, grossPaise: 6000, cashPaise: 6000, upiPaise: 0, cardPaise: 0, duePaise: 0, collectedPaise: 6000 };
const CASH_9999 = { txnCount: 1, grossPaise: 9999, cashPaise: 9999, upiPaise: 0, cardPaise: 0, duePaise: 0, collectedPaise: 9999 };

const amounts = (gross, method) => ({
  gross,
  cash: method === "cash" ? gross : 0,
  upi: method === "upi" ? gross : 0,
  card: method === "card" ? gross : 0,
  due: method === "due" ? gross : 0,
  collected: method === "due" ? 0 : gross,
});

/* --- the state the emulator is holding, mirrored locally ----------- */
const head = { dateKey: DAY, state: "open", counters: { ...ZERO }, openedBy: UID, closedBy: null };
const rows = new Map();

/* --- document builders -------------------------------------------- */

const headWrite = ({ day = head.dateKey, state = head.state, counters = head.counters, openedBy = head.openedBy, closedBy = head.closedBy, updatedBy = UID } = {}) => {
  const fields = {
    dateKey: str(day),
    state: str(state),
    openedAt: ts(),
    openedBy: str(openedBy),
    counters: map(counterFields(counters)),
    updatedAt: ts(),
    updatedBy: str(updatedBy),
  };
  if (state === "closed") {
    fields.closedAt = ts();
    fields.closedBy = str(closedBy || UID);
  }
  return { update: { name: `${DOCS}/dayHeads/${day}`, fields } };
};

const baseTxn = (id, { total = 5000, quantity = 1, rate = total, method = "cash", status = "paid", createdBy = UID, amountsOverride = null, serviceId = "svc_a", serviceName = "Photocopy" } = {}) => ({
  txnId: id,
  serviceId,
  serviceName,
  quantity,
  rate,
  total,
  amounts: amountsOverride || amounts(total, method),
  paymentMethod: method,
  customerId: "",
  customerName: "",
  status,
  dateKey: DAY,
  createdAt: PINNED,
  updatedAt: PINNED,
  createdBy,
  updatedBy: UID,
});

const txnFields = (row) => ({
  txnId: str(row.txnId),
  serviceId: str(row.serviceId),
  serviceName: str(row.serviceName),
  quantity: num(row.quantity),
  rate: num(row.rate),
  total: num(row.total),
  amounts: map(Object.fromEntries(Object.entries(row.amounts).map(([k, v]) => [k, num(v)]))),
  paymentMethod: str(row.paymentMethod),
  customerId: str(row.customerId),
  customerName: str(row.customerName),
  status: str(row.status),
  dateKey: str(row.dateKey),
  createdAt: ts(row.createdAt),
  updatedAt: ts(row.updatedAt),
  createdBy: str(row.createdBy),
  updatedBy: str(row.updatedBy),
});

/* --- runner -------------------------------------------------------- */

async function expect(name, writes, shouldPass, uid = UID) {
  const headers = { "Content-Type": "application/json" };
  if (uid) headers.Authorization = `Bearer ${fakeJwt(uid)}`;
  const res = await fetch(COMMIT, { method: "POST", headers, body: JSON.stringify({ writes }) });
  const body = await res.text();

  /* 400 means the harness's own payload is wrong. Letting that pass as a
     successful denial would make every refusal in this file meaningless. */
  if (res.status === 400) {
    fail++;
    failures.push(name);
    console.log(`  BADRQ ${name} -> bad harness payload, not a rules verdict: ${body.slice(0, 300)}`);
    return;
  }

  /* When a create is refused, the emulator also tries the `update` rule for
     the same path, which trips over the missing `resource.data` and reports
     an evaluation error. The verdict is still a refusal — an evaluation error
     denies in production too — so only the ALLOW path treats a trace error as
     a harness bug, which is what catches a broken rule substitution.
     A trace error on a REFUSED write is counted as a pass, but it is
     reported, because a rule that errors instead of answering is a rule
     nobody can reason about — that is how a whole class of bug hid here. */
  const trace = /evaluation error|Null value error|Function not found|Incorrect number of arguments|Unexpected/.test(body);
  if (trace && shouldPass) {
    fail++;
    failures.push(name);
    console.log(`  BADRQ ${name} -> the rules failed to evaluate, not a verdict: ${body.slice(0, 700)}`);
    return;
  }
  if ((res.ok) === shouldPass) {
    pass++;
    if (trace) {
      traceCount++;
      console.log(`  ok   ${name}   (denied by an evaluation error, not by a plain false)`);
    } else {
      console.log(`  ok   ${name}`);
    }
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name} -> expected ${shouldPass ? "allowed" : "denied"}, got ${res.ok ? "allowed" : "denied"}`);
    console.log(`       ${body.slice(0, 200)}`);
  }
}

/* The counters a sale contributes to its day. */
function stepFor(row) {
  return {
    txnCount: 1,
    grossPaise: row.total,
    cashPaise: row.amounts.cash,
    upiPaise: row.amounts.upi,
    cardPaise: row.amounts.card,
    duePaise: row.amounts.due,
    collectedPaise: row.amounts.collected,
  };
}

const txnWrite = (row) => ({ update: { name: `${DOCS}/dayHeads/${DAY}/transactions/${row.txnId}`, fields: txnFields(row) } });
const delWrite = (id) => ({ delete: `${DOCS}/dayHeads/${DAY}/transactions/${id}` });

/* --- the trust layer ------------------------------------------------- */

/* The proof-of-authorisation. Only an email ever goes on the wire, and the
   rules compare it against allowedUsers — the same document the Admin SDK
   writes and no client can read. */
const enrollWrite = (uid, scope, email, overrides = {}) => ({
  update: {
    name: `${DOCS}/enrollments/${uid}`,
    fields: {
      scope: str(scope),
      email: str(email || "nobody@example.com"),
      createdAt: ts(),
      createdBy: str(uid),
      ...overrides,
    },
  },
});

const grantFields = (uid, { role = "shop", active = true, label = "Test browser", updatedBy = uid } = {}) => ({
  active: bool(active),
  role: str(role),
  label: str(label),
  client: map({ ua: str("Test · Chrome 1"), lang: str("en-IN") }),
  lastUsedAt: ts(),
  createdAt: ts(),
  createdBy: str(uid),
  updatedAt: ts(),
  updatedBy: str(updatedBy),
});

const grantWrite = (uid, opts) => ({
  update: { name: `${DOCS}/accessGrants/${uid}`, fields: grantFields(uid, opts) },
});

/* Reads are not writes, so they need their own path into the emulator. */
async function expectRead(name, path, shouldPass, uid) {
  const headers = uid ? { Authorization: `Bearer ${fakeJwt(uid)}` } : {};
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/${DOCS}/${path}`, { headers });
  if ((res.ok) === shouldPass) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name} -> expected ${shouldPass ? "allowed" : "denied"}, got ${res.ok ? "allowed" : "denied"}`);
  }
}

/* The allowlist entries cannot be written by any client, so they are
   planted as the project owner — the emulator's "Bearer owner" is exactly
   the privilege tools/bootstrap-access.mjs uses in production. */
async function seedSecrets() {
  const res = await fetch(COMMIT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: `${DOCS}/allowedUsers/${EMAIL_SHOP}`,
            fields: { email: str(EMAIL_SHOP), role: str("shop"), createdAt: ts(), createdBy: str("bootstrap"), updatedAt: ts(), updatedBy: str("bootstrap") },
          },
        },
        {
          update: {
            name: `${DOCS}/allowedUsers/${EMAIL_ADMIN}`,
            fields: { email: str(EMAIL_ADMIN), role: str("admin"), createdAt: ts(), createdBy: str("bootstrap"), updatedAt: ts(), updatedBy: str("bootstrap") },
          },
        },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    fail++;
    failures.push("seed allowedUsers");
    console.log(`  BADRQ seeding allowedUsers -> ${res.status} ${body.slice(0, 300)}`);
    return false;
  }
  pass++;
  console.log("  ok   plant the allowlist entries (as project owner, bypassing the rules)");
  return true;
}

/* The sale rules verify, via get(), that the serviceId exists, is active
   and matches the serviceName the client sent. Every sale scenario below
   books against `svc_a`, so it has to actually be there — planted as the
   owner, since a catalog is seeded by the app on first trusted load. */
async function seedService() {
  const res = await fetch(COMMIT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: `${DOCS}/services/svc_a`,
            fields: {
              serviceId: str("svc_a"),
              name: str("Photocopy"),
              code: str("PC"),
              pricePaise: num(5000),
              active: bool(true),
              sortOrder: num(100),
              createdAt: ts(),
              createdBy: str(UID),
              updatedAt: ts(),
              updatedBy: str(UID),
            },
          },
        },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    fail++;
    failures.push("seed the service catalog");
    console.log(`  BADRQ seeding services -> ${res.status} ${body.slice(0, 300)}`);
    return false;
  }
  pass++;
  console.log("  ok   plant the service catalog the sales book against");
  return true;
}

/* The mirrored day must only move once a scenario is actually accepted, or a
   refused write would leave the harness believing a counter it never wrote. */
const nextCounters = (d) => addCounters(head.counters, d);
const dayWrite = (d) => headWrite({ counters: nextCounters(d) });
const commitDay = (d) => { head.counters = nextCounters(d); };

async function expectSale(name, opts, shouldPass, deltas = null, uid = UID) {
  const id = name.match(/\("(\w+)"\)/)?.[1];
  const row = baseTxn(id, opts);
  const d = deltas || stepFor(row);
  await expect(name, [txnWrite(row), dayWrite(d)], shouldPass, uid);
  if (shouldPass) {
    rows.set(id, row);
    commitDay(d);
  }
}

/* --- emulator lifecycle -------------------------------------------- */

function buildWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "txl-rules-"));
  /* `timestamp.date()` takes 3 args; timestamp.value() is the string form. */
  const rules = readFileSync(join(ROOT, "firestore.rules"), "utf8")
    .split("request.time")
    .join(`timestamp.value("${PINNED}")`);
  writeFileSync(join(dir, "firestore.rules"), rules);
  writeFileSync(join(dir, "firestore.indexes.json"), readFileSync(join(ROOT, "firestore.indexes.json")));
  writeFileSync(join(dir, "firebase.json"), JSON.stringify({
    firestore: { rules: "firestore.rules", indexes: "firestore.indexes.json" },
    emulators: { firestore: { port: PORT }, ui: { enabled: false } },
  }, null, 2));
  return dir;
}

async function waitForPort(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* --- scenarios ----------------------------------------------------- */

async function run() {
  console.log("firestore.rules behaviour check\n");

  console.log("the allowlist:");
  if (!(await seedSecrets())) return;
  if (!(await seedService())) return;

  console.log("\nthe trust layer — who gets to reach the money:");
  /* A batch is evaluated against its PRE-batch state, so a proof and the
     grant it buys cannot ride in one commit: every step below is its own
     write, exactly as the app does it. */

  /* Before u1 proves anything, the ledger is closed to everyone. */
  await expect("refuse a ledger write from a browser with no grant", [headWrite({ day: DAY, counters: { ...ZERO } })], false, OUTSIDER);

  await expect("refuse a proof from an account that is not on the allowlist", [enrollWrite(OUTSIDER, "shop", "intruder@example.com")], false, OUTSIDER);
  /* The escalation the whole model rests on. Signing in with Google is open
     to anybody, so if the proof may name any address, this is all an
     outsider has to do: claim the owner's and inherit the shop. */
  await expect("refuse a proof naming another account's allowlisted address", [enrollWrite(UID, "shop", EMAIL_ADMIN)], false, UID);
  await expect("refuse a proof whose scope is neither shop nor admin", [enrollWrite(UID, "superuser", EMAIL_SHOP)], false, UID);
  await expect("refuse a proof claiming somebody else's uid", [enrollWrite(OUTSIDER, "shop", EMAIL_SHOP)], false, UID);
  await expect("refuse a grant with no proof behind it", [grantWrite(UID)], false, UID);
  await expect("refuse a grant that calls itself admin on a shop proof", [grantWrite(UID, { role: "admin" })], false, UID);

  await expect("accept a proof carrying the caller's own authorised email", [enrollWrite(UID, "shop", EMAIL_SHOP)], true, UID);
  await expect("accept a shop grant once the proof is on file", [grantWrite(UID)], true, UID);
  /* Re-sending the identical grant is the last-seen heartbeat, not a
     second enrolment — it must not be mistaken for a privilege change. */
  await expect("accept re-asserting a grant as a last-seen heartbeat", [grantWrite(UID)], true, UID);
  await expectRead("a trusted browser can read its own grant", `accessGrants/${UID}`, true, UID);
  await expectRead("a browser with no grant has no grant at all", `accessGrants/${OUTSIDER}`, false, OUTSIDER);
  await expect("refuse a second proof once a browser is already trusted", [enrollWrite(UID, "shop", EMAIL_SHOP)], false, UID);
  await expect("refuse a trusted browser swapping its own shop proof", [enrollWrite(UID, "shop", "other@example.com")], false, UID);

  console.log("\nthe allowlist itself is unreachable:");
  await expectRead("refuse any client read of allowedUsers/shop@example.com", `allowedUsers/${EMAIL_SHOP}`, false, UID);
  await expectRead("refuse any client read of allowedUsers/admin@example.com", `allowedUsers/${EMAIL_ADMIN}`, false, UID);
  await expect("refuse a client rewriting the shop allowlist entry", [{ update: { name: `${DOCS}/allowedUsers/${EMAIL_SHOP}`, fields: { role: str("admin") } } }], false, UID);
  await expect("refuse a client planting their own admin entry", [{ update: { name: `${DOCS}/allowedUsers/intruder@example.com`, fields: { email: str("intruder@example.com"), role: str("admin") } } }], false, UID);
  await expectRead("refuse reading a proof-of-authorisation", `enrollments/${UID}`, false, UID);
  await expectRead("refuse listing every proof", "enrollments", false, UID);
  await expect("refuse deleting a proof", [{ delete: `${DOCS}/enrollments/${UID}` }], false, UID);

  console.log("\nthe admin role:");
  /* u1 is trusted on the SHOP role only, so it cannot simply promote
     itself — the one capability the whole split rests on. */
  await expect("refuse self-promotion to admin on a shop proof alone", [grantWrite(UID, { role: "admin" })], false, UID);
  await expect("refuse upgrading a trusted proof to an email that is not allowed", [enrollWrite(UID, "admin", "intruder@example.com")], false, UID);
  /* The allowlist's own role is the ceiling. A shop account may ask for
     `admin` in its proof, but the entry behind it says `shop`, and the
     rules believe the entry — so a trusted shop browser can never talk its
     way into the console. */
  await expect("refuse a shop account proving the admin scope", [enrollWrite(UID, "admin", EMAIL_SHOP)], false, UID);

  /* A FRESH browser holding the admin email is the owner's credential and
     mints the admin grant outright. */
  await expect("accept an admin-scope proof carrying the admin email", [enrollWrite(ADMIN_UID, "admin", EMAIL_ADMIN)], true, ADMIN_UID);
  await expect("accept an admin grant minted on an admin proof", [grantWrite(ADMIN_UID, { role: "admin" })], true, ADMIN_UID);
  await expectRead("an admin can read another browser's grant", `accessGrants/${UID}`, true, ADMIN_UID);
  await expectRead("a shop browser cannot read anyone else's grant", `accessGrants/${ADMIN_UID}`, false, UID);
  await expect("refuse a browser with no proof minting an admin grant", [grantWrite(OUTSIDER, { role: "admin" })], false, OUTSIDER);

  console.log("\nupgrading the browser already in the shop:");
  /* The owner's other machine is already trusted, on the shop role. It
     reaches the console the same way a fresh one does — by being signed in
     as the account the allowlist marks `admin` — not by asking for it. */
  await expect("accept that machine proving shop with its own email", [enrollWrite(PROMOTED, "shop", EMAIL_ADMIN)], true, PROMOTED);
  await expect("accept its shop grant", [grantWrite(PROMOTED)], true, PROMOTED);
  await expect("refuse a shop-trusted browser naming the admin address to upgrade", [enrollWrite(UID, "admin", EMAIL_ADMIN)], false, UID);
  await expect("refuse it self-promoting on that", [grantWrite(UID, { role: "admin" })], false, UID);
  await expect("accept the owner's machine upgrading its own proof to admin", [enrollWrite(PROMOTED, "admin", EMAIL_ADMIN)], true, PROMOTED);
  await expect("accept self-promotion on that admin proof", [grantWrite(PROMOTED, { role: "admin" })], true, PROMOTED);
  await expectRead("and it is an admin now", `accessGrants/${PROMOTED}`, true, ADMIN_UID);

  console.log("\na shop browser cannot manage the registry:");
  await expect("accept a second browser proving the shop email", [enrollWrite(PLAIN_UID, "shop", EMAIL_SHOP)], true, PLAIN_UID);
  await expect("accept that browser's shop grant", [grantWrite(PLAIN_UID)], true, PLAIN_UID);
  await expect("refuse a shop browser revoking the admin", [grantWrite(ADMIN_UID, { active: false, updatedBy: PLAIN_UID })], false, PLAIN_UID);
  await expect("refuse a shop browser promoting itself to admin", [grantWrite(PLAIN_UID, { role: "admin" })], false, PLAIN_UID);
  await expect("refuse a browser writing a grant at somebody else's uid", [grantWrite(ADMIN_UID, { role: "admin", updatedBy: PLAIN_UID })], false, PLAIN_UID);
  await expect("refuse a browser deleting another browser's grant", [{ delete: `${DOCS}/accessGrants/${ADMIN_UID}` }], false, PLAIN_UID);
  await expect("accept a shop browser heartbeating its own grant", [grantWrite(PLAIN_UID)], true, PLAIN_UID);

  console.log("\nrevoking a browser:");
  await expect("accept an admin revoking a shop browser", [grantWrite(PLAIN_UID, { active: false, updatedBy: ADMIN_UID })], true, ADMIN_UID);
  await expect("refuse the revoked browser writing a sale", [txnWrite(baseTxn("tR", {})), dayWrite(CASH_5000)], false, PLAIN_UID);
  await expect("refuse the revoked browser re-activating as admin", [grantWrite(PLAIN_UID, { role: "admin", active: true })], false, PLAIN_UID);
  await expect("accept a heartbeat that leaves a revoked grant revoked", [grantWrite(PLAIN_UID, { active: false })], true, PLAIN_UID);
  await expectRead("and it is still not trusted", `accessGrants/${PLAIN_UID}`, true, PLAIN_UID);
  await expect("refuse the revoked browser reading the ledger", [headWrite({ day: DAY, counters: { ...ZERO } })], false, PLAIN_UID);
  /* A revoked browser may still prove an email — that is how it comes back —
     but only its OWN account, and only at a scope its allowlist entry
     permits. So nothing done while revoked can buy a stronger grant than the
     one it was just stripped of. */
  await expect("refuse a revoked browser naming the owner's address", [enrollWrite(PLAIN_UID, "admin", EMAIL_ADMIN)], false, PLAIN_UID);
  await expect("refuse a shop account re-activating as admin", [grantWrite(PLAIN_UID, { role: "admin", active: true })], false, PLAIN_UID);
  await expect("refuse the still-revoked browser opening the day", [headWrite({ day: DAY, counters: { ...ZERO } })], false, PLAIN_UID);
  await expect("accept the revoked browser re-proving its own shop email", [enrollWrite(PLAIN_UID, "shop", EMAIL_SHOP)], true, PLAIN_UID);
  await expect("accept the revoked browser re-activating with it", [grantWrite(PLAIN_UID, { active: true })], true, PLAIN_UID);
  await expectRead("and it is trusted again", `accessGrants/${PLAIN_UID}`, true, PLAIN_UID);

  console.log("\nrevoking an admin demotes it, never restores it:");
  await expect("accept an admin revoking the other admin", [grantWrite(PROMOTED, { active: false, updatedBy: ADMIN_UID })], true, ADMIN_UID);
  /* Reactivation is shop-only, so a revoked admin cannot come back AS an
     admin even holding a valid admin proof of its own — the stronger
     credential gets it nothing it did not already have. This is the case
     the account-bound rule alone would not have caught. */
  await expect("accept the revoked admin filing its own admin proof", [enrollWrite(PROMOTED, "admin", EMAIL_ADMIN)], true, PROMOTED);
  await expect("refuse the demoted admin reactivating as admin", [grantWrite(PROMOTED, { role: "admin", active: true })], false, PROMOTED);
  await expectRead("and it can no longer read the registry", `accessGrants/${PLAIN_UID}`, false, PROMOTED);
  /* It comes back as a plain shop browser, which is the whole point of
     keeping the two roles apart. An `admin` allowlist entry may prove the
     weaker scope; it just may not re-activate on the stronger one. */
  await expect("accept the demoted admin re-proving shop with its own email", [enrollWrite(PROMOTED, "shop", EMAIL_ADMIN)], true, PROMOTED);
  await expect("accept it coming back as shop, not admin", [grantWrite(PROMOTED, { active: true })], true, PROMOTED);
  await expectRead("with shop trust only", `accessGrants/${PLAIN_UID}`, false, PROMOTED);

  console.log("\ncreating a day head:");
  await expect("accept a freshly opened day with zeroed counters", [headWrite({ day: DAY, counters: { ...ZERO } })], true, UID);
  /* The head is really on disk now, so a refused read is a genuine 403 and
     not merely a missing document. */
  await expectRead("a trusted browser can read the day head", `dayHeads/${DAY}`, true, UID);
  await expectRead("a browser with no grant cannot", `dayHeads/${DAY}`, false, OUTSIDER);
  await expectRead("an anonymous caller cannot either", `dayHeads/${DAY}`, false, null);
  await expect("refuse counters whose buckets do not sum to the gross", [headWrite({ day: "2026-09-28", counters: { ...ZERO, txnCount: 1, grossPaise: 5000, cashPaise: 4000 } })], false);
  await expect("refuse counters collecting more than the gross", [headWrite({ day: "2026-09-29", counters: { ...ZERO, txnCount: 1, grossPaise: 5000, cashPaise: 5000, collectedPaise: 6000 } })], false);
  await expect("refuse negative counters", [headWrite({ day: "2026-09-30", counters: { ...ZERO, txnCount: -1 } })], false);
  await expect("refuse a head opened by somebody else", [headWrite({ day: "2026-10-01", counters: { ...ZERO }, openedBy: "someone-else" })], false);

  console.log("\nthe money path — a sale and the day head, in one batch:");
  await expectSale('accept a sale that moves the head by exactly that sale ("t1")', {}, true);
  await expectSale('refuse a sale that moves the head by the wrong amount ("t2")', {}, false, { ...CASH_9999 });
  await expectSale('refuse a sale booked into a different bucket ("t3")', {}, false, { txnCount: 1, grossPaise: 5000, upiPaise: 5000, collectedPaise: 5000 });
  await expectSale('refuse a sale that does not move the head at all ("t4")', {}, false, {});
  await expectSale('refuse a sale whose amounts do not add up to its total ("t5")', { amountsOverride: { ...amounts(5000, "cash"), cash: 4000 } }, false, { txnCount: 1, grossPaise: 5000, cashPaise: 4000, collectedPaise: 5000 });
  await expectSale('refuse a sale claiming a different author ("t6")', { createdBy: "someone-else" }, false);
  await expectSale('refuse a due sale that claims to be already collected ("t7")', { method: "due", status: "pending", amountsOverride: amounts(5000, "cash") }, false);
  await expectSale('refuse a sale whose total is not quantity x rate ("t8")', { quantity: 2, rate: 3000, total: 5000 }, false);
  await expectSale('accept a multi-unit sale priced consistently ("t9")', { quantity: 2, rate: 2500, total: 5000 }, true);

  console.log("\nthe service catalog is not a suggestion:");
  /* A serviceId that does not exist used to raise an evaluation error
     rather than a plain denial: `exists(p) && get(p).data.x` does not
     short-circuit, so the missing field surfaced anyway. An errored rule
     still denies, so this was never a way in — but it made every refusal
     unreadable, and it hid this whole class of bug from the tests. */
  await expectSale('refuse a sale against a service that does not exist ("tS")', { serviceId: "svc_missing", serviceName: "Ghost" }, false);
  await expectSale('refuse a sale whose serviceName does not match ("tM")', { serviceName: "Lying" }, false);
  {
    /* And a deactivated service stops selling, which is the whole point of
       keeping the catalog in the same database. */
    await expect("deactivate the service (as an admin)", [{ update: { name: `${DOCS}/services/svc_a`, fields: { serviceId: str("svc_a"), name: str("Photocopy"), code: str("PC"), pricePaise: num(5000), active: bool(false), sortOrder: num(100), createdAt: ts(), createdBy: str(UID), updatedAt: ts(), updatedBy: str(UID) } } }], true, UID);
    await expectSale('refuse a sale against a deactivated service ("tD")', {}, false);
    await expect("reactivate the service", [{ update: { name: `${DOCS}/services/svc_a`, fields: { serviceId: str("svc_a"), name: str("Photocopy"), code: str("PC"), pricePaise: num(5000), active: bool(true), sortOrder: num(100), createdAt: ts(), createdBy: str(UID), updatedAt: ts(), updatedBy: str(UID) } } }], true, UID);
  }

  console.log("\ncorrecting a sale:");
  const t1 = rows.get("t1");
  const t1Up = { ...t1, total: 6000, rate: 6000, amounts: amounts(6000, "cash") };
  await expect("refuse an edit that changes the total without the head", [txnWrite(t1Up)], false);
  await expect("accept an edit that moves the head by exactly the difference", [txnWrite(t1Up), dayWrite({ grossPaise: 1000, cashPaise: 1000, collectedPaise: 1000 })], true);
  rows.set("t1", t1Up);
  commitDay({ grossPaise: 1000, cashPaise: 1000, collectedPaise: 1000 });

  console.log("\nsettling a due sale:");
  const due = baseTxn("d1", { method: "due", status: "pending" });
  await expect("accept a due sale, which adds to due and not to collected", [txnWrite(due), dayWrite(stepFor(due))], true);
  rows.set("d1", due);
  commitDay(stepFor(due));
  await expect("accept settling a due sale in place, since settling moves no money", [txnWrite({ ...due, status: "paid" })], true);
  await expect("refuse editing a settled sale's pinned serviceId", [txnWrite({ ...due, status: "paid", serviceId: "svc_b" })], false);
  await expect("refuse re-dating a settled sale", [txnWrite({ ...due, status: "paid", dateKey: "2026-10-02" })], false);
  const dropDue = { txnCount: -1, grossPaise: -5000, duePaise: -5000 };
  await expect("accept removing the settled due sale, which retreats the day", [delWrite("d1"), dayWrite(dropDue)], true);
  rows.delete("d1");
  commitDay(dropDue);

  await expect("refuse a delete that does not step the day back", [delWrite("t1")], false);
  const dropT1 = { txnCount: -1, grossPaise: -6000, cashPaise: -6000, collectedPaise: -6000 };
  await expect("accept a delete that steps the day back", [delWrite("t1"), dayWrite(dropT1)], true);
  rows.delete("t1");
  commitDay(dropT1);

  console.log("\nclosing the day:");
  await expect("accept closing an open day", [headWrite({ state: "closed" })], true);
  head.state = "closed";
  await expect("refuse a sale against a closed day", [txnWrite(baseTxn("t10", {})), dayWrite(CASH_5000)], false);
  await expect("refuse reopening a closed day", [headWrite({ state: "open" })], false);

  console.log("\neverything outside the day head:");
  await expect("refuse a write to the old flat transactions collection", [{ update: { name: `${DOCS}/transactions/t9`, fields: { total: num(1) } } }], false);
  await expect("refuse a write to the old days collection", [{ update: { name: `${DOCS}/days/${DAY}`, fields: { closed: bool(true) } } }], false);
  await expect("refuse a write to the old services collection", [{ update: { name: `${DOCS}/services/svc_a`, fields: { name: str("x") } } }], false);
  await expect("refuse a write to devices", [{ update: { name: `${DOCS}/devices/abc`, fields: { active: bool(true) } } }], false);
  await expect("refuse a write to the old RTDB-era admins collection", [{ update: { name: `${DOCS}/admins/${UID}`, fields: { uid: str(UID) } } }], false);
  await expect("refuse an anonymous write", [txnWrite(baseTxn("t11", {})), dayWrite(CASH_5000)], false, null);

  console.log("\nthe shop record:");
  const shopDoc = (uid, over = {}) => ({
    update: {
      name: `${DOCS}/shop/general`,
      fields: {
        name: str("TrustX Ledger"),
        phone: str(""),
        address: str(""),
        currency: str("INR"),
        active: bool(true),
        createdAt: ts(),
        createdBy: str(uid),
        updatedAt: ts(),
        updatedBy: str(uid),
        ...over,
      },
    },
  });
  await expect("refuse a shop record write from a browser with no grant", [shopDoc(NOBODY)], false, NOBODY);
  await expect("refuse an anonymous shop record write", [shopDoc(NOBODY)], false, null);
  await expect("refuse a shop record with a non-INR currency", [shopDoc(UID, { currency: str("USD") })], false, UID);
  await expect("refuse a shop record with an empty name", [shopDoc(UID, { name: str("") })], false, UID);
  await expect("accept a well-formed shop record from a trusted browser", [shopDoc(UID)], true, UID);
  await expect("refuse rewriting who created the shop record", [shopDoc(UID, { createdBy: str("someone-else") })], false, UID);
  await expect("refuse deleting the shop record", [{ delete: `${DOCS}/shop/general` }], false, UID);
}

const dir = buildWorkspace();
const child = spawn("cmd.exe", ["/c", "firebase", "emulators:start", "--only", "firestore", "--project", "trustxplpy"], { cwd: dir, stdio: "ignore" });

let code = 1;
try {
  if (!(await waitForPort(PORT, 90000))) {
    console.error("emulator did not start");
  } else {
    await run();
    code = fail ? 1 : 0;
  }
} finally {
  /* taskkill /T reaches the java process underneath cmd.exe; killing the cmd
     handle alone would leave it holding the port. */
  try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log("failing: " + failures.join(" | "));
  if (traceCount) {
    console.log(`\n${traceCount} of those refusals came from a rule that raised an evaluation`);
    console.log("error instead of answering false. Each still denies, so none is a way in,");
    console.log("but a denial nobody can read is a denial nobody can test. Worth a look.");
  }
process.exit(code);
