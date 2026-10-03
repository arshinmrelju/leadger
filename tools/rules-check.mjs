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
const BRIDGE = "u7";   // the office phone: anonymous sign-in, claim-minted identity

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
let skipCount = 0;
const failures = [];
const skipped = [];

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
  /* The office bridge has no allowlist email at all: its whole
     identity is the server-minted bridge claim. */
  if (uid === BRIDGE) claims.bridge = true;
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

/**
 * A day-head write.
 *
 * Every write here resends the whole document (see the note at the top of
 * this file: the emulator's REST bridge refuses a mask), and a resend is
 * how a reopen deletes its closing stamp — the field is simply left out.
 * That is exactly what the client does with a field delete, and it is why
 * the rules' openHeadShape, which forbids closedAt/closedBy on an open
 * head, is testable here at all.
 *
 * `keepClosingStamp` builds the wrong version of a reopen (state open,
 * stamp still present) so the rules can be shown to refuse it.
 */
const headWrite = ({
  day = head.dateKey,
  state = head.state,
  counters = head.counters,
  openedBy = head.openedBy,
  closedBy = head.closedBy,
  updatedBy = UID,
  keepClosingStamp = false,
} = {}) => {
  const fields = {
    dateKey: str(day),
    state: str(state),
    openedAt: ts(),
    openedBy: str(openedBy),
    counters: map(counterFields(counters)),
    updatedAt: ts(),
    updatedBy: str(updatedBy),
  };
  if (state === "closed" || (keepClosingStamp && head.state === "closed")) {
    fields.closedAt = ts();
    fields.closedBy = str(closedBy || UID);
  }
  return { update: { name: `${DOCS}/dayHeads/${day}`, fields } };
};

const baseTxn = (id, { total = 5000, quantity = 1, rate = total, method = "cash", status = "paid", createdBy = UID, amountsOverride = null, serviceId = "svc_a", serviceName = "Photocopy", hasReceipt = false } = {}) => ({
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
  /* A sale says whether it has a photograph; the photograph itself is a
     separate document, so this marker is all a listing of the day ever
     reads — which is the point of keeping the picture out of the sale. */
  hasReceipt,
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
  hasReceipt: bool(row.hasReceipt),
  createdAt: ts(row.createdAt),
  updatedAt: ts(row.updatedAt),
  createdBy: str(row.createdBy),
  updatedBy: str(row.updatedBy),
});

/* The photograph of a receipt: its own small document beside the sale, not a
   field on the sale and not a file in Cloud Storage. `bytes` is the decoded
   JPEG size, which is what the ceiling is really about — base64 is just the
   wire form of the same picture. The payload below is a real JPEG header, not
   a picture: the rules judge the shape and the size, not the photograph. */
const JPEG_HEAD = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD";

const imageWrite = (id, over = {}) => ({
  update: {
    name: `${DOCS}/dayHeads/${DAY}/receiptImages/${id}`,
    fields: {
      txnId: str(id),
      image: str(JPEG_HEAD),
      bytes: num(1024),
      capturedAt: ts(),
      createdBy: str(UID),
      ...over,
    },
  },
});

const imageDel = (id) => ({ delete: `${DOCS}/dayHeads/${DAY}/receiptImages/${id}` });

/* --- runner -------------------------------------------------------- */

/**
 * A case this harness cannot drive, reported instead of quietly passed.
 *
 * Used where a precondition could not be established (a write the
 * emulator refused to evaluate), so a green run never claims to have
 * checked something it did not.
 */
function skip(name, reason) {
  skipCount++;
  skipped.push(name);
  console.log(`  SKIP ${name} -> ${reason}`);
}

/**
 * Put the emulator into a state the rules cannot be driven into here.
 *
 * `Bearer owner` is the Firestore emulator's documented admin credential: it
 * bypasses security rules the way the Admin SDK does. The harness uses it for
 * TWO things — planting the allowlist and the service catalog (which no
 * client may write at all), and planting a genuinely closed day head as a
 * fallback, in case the close through the rules ever fails to evaluate.
 * Without a real closed day, every reopen case would be testing an OPEN day
 * and would prove nothing.
 *
 * It is deliberately not used to make an assertion pass: the seed only writes
 * the state the rules are then judged against, and every assertion below it
 * still runs as the shop user with real rules in force.
 */
async function seedAsAdmin(writes) {
  const res = await fetch(COMMIT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({ writes }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`rules-bypassing seed failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

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

/**
 * Run a real query against the emulator as `uid`. The rules harness only
 * ever did document reads, so the history page's query shape - the one
 * thing the page cannot work without - went untested until it was denied
 * in production and the cause was the catch-all rule at the bottom of
 * firestore.rules. A group query over "transactions" is still denied, and
 * that denial is the point of the next case: it is why js/ledger.js reads
 * the history day by day instead.
 */
async function expectQuery(name, structuredQuery, shouldPass, uid) {
  const headers = uid ? { "Content-Type": "application/json", Authorization: `Bearer ${fakeJwt(uid)}` } : { "Content-Type": "application/json" };
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/${DOCS}:runQuery`, {
    method: "POST",
    headers,
    body: JSON.stringify({ structuredQuery }),
  });
  if ((res.ok) === shouldPass) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    const why = (await res.text()).replace(/\s+/g, " ").slice(0, 120);
    console.log(`  FAIL ${name} -> expected ${shouldPass ? "allowed" : "denied"}, got ${res.ok ? "allowed" : "denied"} ${why}`);
  }
}

const byCreatedDesc = [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }];

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

  console.log("\nthe receipt photograph, kept in its own document:");
  /* The photo is committed in the SAME batch as the sale it belongs to, so
     a photograph can never outlive a sale or arrive without one. That is
     also why the rule reads the sale with getAfter() rather than exists():
     a rule judging `exists` sees the world as it was BEFORE the batch, and
     the sale is not in it yet — the photo would be refused for the company
     of a sale that is arriving in the very same commit. */
  const photoSale = baseTxn("tR1", { hasReceipt: true });
  await expect('accept a sale and its receipt photograph in one commit ("tR1")',
    [txnWrite(photoSale), dayWrite(stepFor(photoSale)), imageWrite("tR1")], true);
  rows.set("tR1", photoSale);
  commitDay(stepFor(photoSale));

  await expect("refuse a photograph for a sale that is not there", [imageWrite("tGhost")], false);
  await expect("refuse a photograph whose decoded size is over the ceiling", [imageWrite("tR1", { bytes: num(614401) })], false);
  await expect("refuse a photograph that is not a JPEG", [imageWrite("tR1", { image: str("data:image/png;base64,iVBORw0KGgo=") })], false);
  await expect("refuse a photograph that claims somebody else as its author", [imageWrite("tR1", { createdBy: str("someone-else") })], false);
  await expect("refuse a photograph filed under another sale's id", [imageWrite("tR1", { txnId: str("t9") })], false);
  /* A scan is a record of what the paper said. Rewriting it in place would
     let the picture attached to a sale quietly become a different picture,
     so the document is create-only: re-scanning deletes and re-creates. */
  await expect("refuse rewriting a stored photograph in place", [imageWrite("tR1", { image: str(JPEG_HEAD + "AAAA") })], false);
  await expect("refuse a photograph from a browser with no grant", [imageWrite("tR2")], false, OUTSIDER);
  await expect("refuse a photograph from an anonymous caller", [imageWrite("tR2")], false, null);

  await expectRead("a trusted browser can read the photograph", `dayHeads/${DAY}/receiptImages/tR1`, true, UID);
  await expectRead("a browser with no grant cannot", `dayHeads/${DAY}/receiptImages/tR1`, false, OUTSIDER);
  await expectRead("an anonymous caller cannot either", `dayHeads/${DAY}/receiptImages/tR1`, false, null);
  /* The photo goes when its sale goes, and while the day is still open that
     is a write like any other; the closed-day case below refuses it. */
  await expect("accept deleting a photograph while the day is open", [imageDel("tR1")], true);
  await expect("accept re-attaching a photograph to the same sale", [imageWrite("tR1")], true);

  console.log("\nthe queries the history page actually runs:");
  /* The history page walks the day heads newest-first and then reads one
     day's sales. The day-heads query is checked here; the per-day read is
     the same query the daily ledger already runs for the open day, and
     the emulator's REST runQuery cannot express a subcollection at all. */
  await expectQuery("a trusted browser can list the day heads it walks",
    { from: [{ collectionId: "dayHeads" }], orderBy: [{ field: { fieldPath: "dateKey" }, direction: "DESCENDING" }], limit: 60 }, true, UID);
  await expectQuery("an outsider cannot list the day heads",
    { from: [{ collectionId: "dayHeads" }], orderBy: [{ field: { fieldPath: "dateKey" }, direction: "DESCENDING" }], limit: 60 }, false, OUTSIDER);
  /* Documented here so the denial is not rediscovered as a bug: the
     catch-all `match /{document=**}` denies the root-level
     `transactions` collection, a group query spans that path too, and
     Firestore refuses any query it cannot prove safe. This is why
     js/ledger.js serves the all-time history day by day. */
  await expectQuery("refuse a collection-group query over transactions (the catch-all denies it, by design)",
    { from: [{ collectionId: "transactions", allDescendants: true }], orderBy: byCreatedDesc, limit: 200 }, false, UID);
  await expectQuery("refuse an anonymous collection-group query over transactions",
    { from: [{ collectionId: "transactions", allDescendants: true }], orderBy: byCreatedDesc, limit: 200 }, false, null);

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
  const failsBeforeClose = failures.length;
  await expect("accept closing an open day", [headWrite({ state: "closed" })], true);
  /* Whether the close actually committed. If a rule change ever leaves the
     close unable to evaluate, the head on the server is still open and every
     case below would be quietly testing an OPEN day — a broken test, not a
     red one. So the state is verified, and only planted out of band if the
     rules themselves failed to produce it: the close is already recorded
     above as whatever the rules actually did, and the refusals here are
     judged against a real closed day. If even the admin-token seed cannot be
     made, the cases are reported as NOT driven rather than allowed to pass
     against the wrong state. */
  const closeLanded = failures.length === failsBeforeClose;
  let closedDayReady = closeLanded;
  if (!closedDayReady) {
    try {
      await seedAsAdmin([headWrite({ state: "closed" })]);
      closedDayReady = true;
      console.log("  note: the closed day was planted with the emulator's admin token");
    } catch (err) {
      console.log(`  note: could not plant a closed day -> ${err.message}`);
    }
  }

  if (!closedDayReady) {
    const why = "no closed day could be established on this emulator";
    skip("refuse a sale against a closed day", why);
    skip("refuse editing a sale on a closed day", why);
    skip("refuse deleting a sale on a closed day", why);
    skip("refuse attaching a photograph on a closed day", why);
    skip("refuse deleting a photograph on a closed day", why);
    skip("refuse a reopen that keeps the closing stamp", why);
    skip("refuse a reopen that also moves the counters", why);
    skip("accept reopening a closed day", why);
  } else {
    head.state = "closed";
    await expect("refuse a sale against a closed day", [txnWrite(baseTxn("t10", {})), dayWrite(CASH_5000)], false);
    await expect("refuse editing a sale on a closed day", [txnWrite(baseTxn("t10", {}))], false);
    await expect("refuse deleting a sale on a closed day", [delWrite("d1")], false);
    /* The photo rides the sale's rules: a closed day takes no photographs,
       neither a new one against a sale already on file nor the removal of
       an existing one. Reading it stays allowed — closing a day locks the
       money, it does not hide the record. */
    await expect("refuse attaching a photograph on a closed day", [imageWrite("t9")], false);
    await expect("refuse deleting a photograph on a closed day", [imageDel("tR1")], false);
    await expectRead("a trusted browser can still read a photograph on a closed day",
      `dayHeads/${DAY}/receiptImages/tR1`, true, UID);

    /* Reopening is how a mistake on a finished day gets fixed, so it has to
       be possible — but it is a state change, never a money change. The two
       refusals are the whole of what makes it safe: the counters may not
       move, and the closing stamp may not be left behind (openHeadShape
       forbids it, so a lingering stamp would break every later write to
       that day). */
    /* The moved counters are derived from the day as it stands rather than
       hard-coded: a fixed set could coincide with what the day already
       holds, and then the "move" would be no move at all and the reopen
       would be correct to allow it. That is a bug this harness actually had,
       and it only showed up once the closed day was real. */
    const countersMoved = { ...head.counters, grossPaise: head.counters.grossPaise + 1 };
    await expect("refuse a reopen that keeps the closing stamp", [headWrite({ state: "open", keepClosingStamp: true })], false);
    await expect("refuse a reopen that also moves the counters", [headWrite({ state: "open", counters: countersMoved })], false);
    await expect("accept reopening a closed day", [headWrite({ state: "open" })], true);
    head.state = "open";
    /* A reopened day is writable again, because every sale rule reads the
       day's state from the head through dayOpen() — the same read the
       "refuse a sale against a closed day" case above turns on. */
  }

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

  console.log("\nthe Telegram daily report (the office bridge):");
  /* The day was reopened after the closing scenarios, so this section
     closes it for real first — through the rules, exactly as the
     ledger's Close day button does — and keeps its own mirror of the
     report document, because every write here resends the whole doc. */
  await expect("accept closing the day for the report scenarios", [headWrite({ state: "closed" })], true);
  head.state = "closed";

  const EXPENSES = 500;
  const baseReport = () => ({
    businessDate: DAY,
    status: "pending",
    reportVersion: 1,
    createdAt: PINNED,
    closedAt: PINNED,
    createdBy: UID,
    counters: { ...head.counters },
    expensesPaise: EXPENSES,
    netPaise: head.counters.collectedPaise - EXPENSES,
    attemptCount: 0,
  });
  /* A claim: fresh stamps, attempt+1, and every delivery field of the
     previous outcome dropped — including lastError, whose absence the
     rules require once the status leaves `failed`. */
  const claimOf = (r) => {
    const c = { ...r, status: "sending", sendingAt: PINNED, lastAttemptAt: PINNED, attemptCount: r.attemptCount + 1 };
    delete c.lastError; delete c.sentAt; delete c.telegramMessageId;
    return c;
  };
  const stripDelivery = (r) => {
    const c = { ...r, status: "pending" };
    delete c.sendingAt; delete c.lastAttemptAt; delete c.sentAt; delete c.telegramMessageId; delete c.lastError;
    return c;
  };
  const reportFields = (r) => {
    const f = {
      businessDate: str(r.businessDate),
      status: str(r.status),
      reportVersion: num(r.reportVersion),
      createdAt: ts(r.createdAt),
      closedAt: ts(r.closedAt),
      createdBy: str(r.createdBy),
      counters: map(counterFields(r.counters)),
      expensesPaise: num(r.expensesPaise),
      netPaise: num(r.netPaise),
      attemptCount: num(r.attemptCount),
    };
    if (r.sendingAt) f.sendingAt = ts(r.sendingAt);
    if (r.lastAttemptAt) f.lastAttemptAt = ts(r.lastAttemptAt);
    if (r.sentAt) f.sentAt = ts(r.sentAt);
    if (r.telegramMessageId) f.telegramMessageId = num(r.telegramMessageId);
    if (r.lastError) f.lastError = str(r.lastError);
    return f;
  };
  const reportWrite = (r) => ({ update: { name: `${DOCS}/dailyReports/${r.businessDate}`, fields: reportFields(r) } });
  const reportDel = (d) => ({ delete: `${DOCS}/dailyReports/${d}` });
  const wrongCounters = {
    ...head.counters,
    grossPaise: head.counters.grossPaise + 1,
    cashPaise: head.counters.cashPaise + 1,
    collectedPaise: head.counters.collectedPaise + 1,
  };
  let rep = null;

  await expect("refuse a report create from a browser with no grant", [reportWrite(baseReport())], false, OUTSIDER);
  await expect("refuse a report create from an anonymous caller", [reportWrite(baseReport())], false, null);
  await expect("refuse a report create from the bridge (creating is the web's job)", [reportWrite(baseReport())], false, BRIDGE);
  await expect("refuse a report whose counters do not match the closed day head",
    [reportWrite({ ...baseReport(), counters: wrongCounters, netPaise: wrongCounters.collectedPaise - EXPENSES })], false, UID);
  await expect("refuse a report whose net is not collections minus expenses",
    [reportWrite({ ...baseReport(), netPaise: head.counters.collectedPaise - EXPENSES + 1 })], false, UID);
  await expect("refuse a report trying to carry a bot token field",
    [{ update: { name: `${DOCS}/dailyReports/${DAY}`, fields: { ...reportFields(baseReport()), telegramBotToken: str("123:secret") } } }], false, UID);
  await expect("accept a pending report that mirrors the closed day head", [reportWrite(baseReport())], true, UID);
  rep = baseReport();

  await expectRead("the office bridge can read its report", `dailyReports/${DAY}`, true, BRIDGE);
  await expectRead("a trusted browser can read the report", `dailyReports/${DAY}`, true, UID);
  await expectRead("a browser with no grant cannot read the report", `dailyReports/${DAY}`, false, OUTSIDER);
  await expectRead("an anonymous caller cannot read the report", `dailyReports/${DAY}`, false, null);
  const pendingQuery = { from: [{ collectionId: "dailyReports" }], where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } }, limit: 5 };
  await expectQuery("the bridge can query for pending reports", pendingQuery, true, BRIDGE);
  await expectQuery("an outsider cannot query dailyReports", pendingQuery, false, OUTSIDER);

  await expect("refuse a claim from a session without the bridge claim", [reportWrite(claimOf(rep))], false, UID);
  await expect("refuse the bridge moving the money in its claim",
    [reportWrite({ ...claimOf(rep), counters: wrongCounters, netPaise: wrongCounters.collectedPaise - EXPENSES })], false, BRIDGE);
  await expect("refuse the bridge bumping the report version in its claim",
    [reportWrite({ ...claimOf(rep), reportVersion: 99 })], false, BRIDGE);
  await expect("accept the bridge claiming the pending report", [reportWrite(claimOf(rep))], true, BRIDGE);
  rep = claimOf(rep);

  /* Test 11 in rules form: a second instance claims a moment later and
     loses. Only one official delivery can ever leave this document. */
  await expect("refuse a second claim while the first is fresh (two bridges, one delivery)",
    [reportWrite(claimOf(rep))], false, BRIDGE);

  await expect("refuse recording a failure with no error text",
    [reportWrite({ ...rep, status: "failed" })], false, BRIDGE);
  await expect("accept the bridge recording a successful Telegram delivery",
    [reportWrite({ ...rep, status: "sent", sentAt: PINNED, telegramMessageId: 12345 })], true, BRIDGE);
  rep = { ...rep, status: "sent", sentAt: PINNED, telegramMessageId: 12345 };

  await expect("refuse claiming a report that is already sent", [reportWrite(claimOf(rep))], false, BRIDGE);
  await expect("refuse the web un-sending a delivered report",
    [reportWrite(stripDelivery(rep))], false, UID);

  await expect("accept a re-close queueing a fresh version after delivery",
    [reportWrite({ ...stripDelivery(rep), reportVersion: rep.reportVersion + 1, attemptCount: 0 })], true, UID);
  rep = { ...stripDelivery(rep), reportVersion: rep.reportVersion + 1, attemptCount: 0 };
  await expect("refuse a re-close that does not bump the report version",
    [reportWrite(rep)], false, UID);

  await expect("accept the bridge claiming the fresh version", [reportWrite(claimOf(rep))], true, BRIDGE);
  rep = claimOf(rep);
  await expect("accept the bridge recording a Telegram refusal",
    [reportWrite({ ...rep, status: "failed", lastError: "telegram: 400 Bad Request: chat not found" })], true, BRIDGE);
  rep = { ...rep, status: "failed", lastError: "telegram: 400 Bad Request: chat not found" };

  /* The bridge retries by re-claiming its own failure — the offline
     queue in rules form. */
  await expect("accept the bridge re-claiming its failed report", [reportWrite(claimOf(rep))], true, BRIDGE);
  rep = claimOf(rep);
  await expect("accept failing again with the new error",
    [reportWrite({ ...rep, status: "failed", lastError: "telegram: network unreachable" })], true, BRIDGE);
  rep = { ...rep, status: "failed", lastError: "telegram: network unreachable" };
  await expect("accept the web requeueing a failed report (Retry)",
    [reportWrite(stripDelivery(rep))], true, UID);
  rep = stripDelivery(rep);
  await expect("refuse the web requeueing a report that has not failed",
    [reportWrite(rep)], false, UID);

  /* Stale-sending recovery. The rules judge `request.time`, which the
     harness pins, so "an hour ago" can only be planted out of band —
     with the same admin token the harness already uses to seed a
     closed day. Everything asserted below still runs as the bridge. */
  await expect("accept the bridge claiming the requeued report", [reportWrite(claimOf(rep))], true, BRIDGE);
  rep = claimOf(rep);
  await seedAsAdmin([reportWrite({ ...rep, sendingAt: "2026-09-27T03:00:00.000Z", lastAttemptAt: "2026-09-27T03:00:00.000Z" })]);
  await expect("accept the bridge reclaiming a stale sending report (crashed phone)",
    [reportWrite(claimOf(rep))], true, BRIDGE);
  rep = claimOf(rep);
  await expect("accept the reclaimed report failing once more",
    [reportWrite({ ...rep, status: "failed", lastError: "telegram: timed out" })], true, BRIDGE);
  rep = { ...rep, status: "failed", lastError: "telegram: timed out" };

  await expect("refuse the bridge deleting a report instead of delivering it",
    [reportDel(DAY)], false, BRIDGE);

  await expect("accept reopening the day with a failed report still queued",
    [headWrite({ state: "open" })], true);
  head.state = "open";
  await expect("accept the web dropping the undelivered report on reopen",
    [reportDel(DAY)], true, UID);
  rep = null;

  /* The delivered half of the same story: close again, deliver, and
     find that a reopen can never take back what the owner already
     holds. */
  await expect("accept re-closing the day", [headWrite({ state: "closed" })], true);
  head.state = "closed";
  await expect("accept a fresh pending report for the new close",
    [reportWrite(baseReport())], true, UID);
  rep = baseReport();
  await expect("accept the bridge claiming it", [reportWrite(claimOf(rep))], true, BRIDGE);
  rep = claimOf(rep);
  await expect("accept the bridge marking it delivered",
    [reportWrite({ ...rep, status: "sent", sentAt: PINNED, telegramMessageId: 777 })], true, BRIDGE);
  rep = { ...rep, status: "sent", sentAt: PINNED, telegramMessageId: 777 };

  await expect("accept reopening the day with a delivered report",
    [headWrite({ state: "open" })], true);
  head.state = "open";
  await expect("refuse deleting a delivered report (the owner keeps the record)",
    [reportDel(DAY)], false, UID);

  console.log("\nthe bridge reaches nothing but its own queue:");
  await expect("refuse the bridge writing a sale",
    [txnWrite(baseTxn("tB", {}))], false, BRIDGE);
  await expect("refuse the bridge rewriting the day head",
    [headWrite({ counters: { ...head.counters, grossPaise: head.counters.grossPaise + 500, cashPaise: head.counters.cashPaise + 500, collectedPaise: head.counters.collectedPaise + 500 } })], false, BRIDGE);
  await expect("refuse the bridge touching the service catalog",
    [{ update: { name: `${DOCS}/services/svc_a`, fields: { serviceId: str("svc_a"), name: str("Photocopy"), code: str("PC"), pricePaise: num(1), active: bool(true), sortOrder: num(100), createdAt: ts(), createdBy: str(UID), updatedAt: ts(), updatedBy: str(UID) } } }], false, BRIDGE);
  await expect("refuse the bridge minting an access grant (admin permissions)",
    [grantWrite(PLAIN_UID)], false, BRIDGE);
  await expectRead("refuse the bridge reading the allowlist", `allowedUsers/${EMAIL_SHOP}`, false, BRIDGE);
  await expectRead("refuse the bridge reading a day head", `dayHeads/${DAY}`, false, BRIDGE);
  await expectRead("refuse the bridge reading a trusted browser's grant", `accessGrants/${UID}`, false, BRIDGE);
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
  if (skipCount) {
    console.log(`\n${skipCount} case(s) could not be driven and were NOT checked:`);
    console.log("  " + skipped.join(" | "));
  }
  if (traceCount) {
    console.log(`\n${traceCount} of those refusals came from a rule that raised an evaluation`);
    console.log("error instead of answering false. Each still denies, so none is a way in,");
    console.log("but a denial nobody can read is a denial nobody can test. Worth a look.");
  }
process.exit(code);
