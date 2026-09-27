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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8123;
const PINNED = "2026-09-27T04:00:00.000Z";
/* Inside a write, `name` is the bare resource path; a full URL is rejected
   with "lacks projects at index 0". Only the request URL carries a host. */
const DOCS = "projects/trustxplpy/databases/(default)/documents";
const COMMIT = `http://127.0.0.1:${PORT}/v1/${DOCS}:commit`;
const UID = "u1";
const DAY = "2026-09-27";

let pass = 0;
let fail = 0;
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
  return [b64({ alg: "none", typ: "JWT" }), b64({ user_id: uid, sub: uid, iat: now, exp: now + 3600 }), ""].join(".");
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

const baseTxn = (id, { total = 5000, quantity = 1, rate = total, method = "cash", status = "paid", createdBy = UID, amountsOverride = null } = {}) => ({
  txnId: id,
  serviceId: "svc_a",
  serviceName: "Photocopy",
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
     a harness bug, which is what catches a broken rule substitution. */
  const broke = /evaluation error|Function not found|Incorrect number of arguments|Unexpected/.test(body);
  if (broke && shouldPass) {
    fail++;
    failures.push(name);
    console.log(`  BADRQ ${name} -> the rules failed to evaluate, not a verdict: ${body.slice(0, 700)}`);
    return;
  }
  if ((res.ok) === shouldPass) {
    pass++;
    console.log(`  ok   ${name}`);
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
  console.log("firestore.rules day-head behaviour check\n");

  console.log("creating a day head:");
  await expect("accept a freshly opened day with zeroed counters", [headWrite({ day: DAY, counters: { ...ZERO } })], true);
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
  await expect("refuse an anonymous write", [txnWrite(baseTxn("t11", {})), dayWrite(CASH_5000)], false, null);
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
process.exit(code);
