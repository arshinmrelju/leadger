/* =========================================================
   TrustX Ledger — access-code bootstrap / rotation / recovery
   -----------------------------------------------------------------
   Writes the two access-code hashes that the whole sign-in model rests
   on, into Firestore `securitySecrets/{shop,admin}`.

   WHY A SEPARATE TOOL
   `firestore.rules` denies every read and write on `securitySecrets/**`.
   That is the point: no browser can read the hashes or replace them. So
   the codes have to be planted from somewhere with authority, and the
   somewhere is this script, using a service-account key. It bypasses
   the rules because the Admin SDK does — it authenticates as the
   project owner, not as a browser.

   NO DEPENDENCIES, ON PURPOSE
   This is a static app whose whole install story is "no npm install".
   Pulling in firebase-admin just to sign one JWT would undo that, so
   the token exchange is done directly: a service account's private key
   signs a JWT (RS256, built with node:crypto) which Google's token
   endpoint exchanges for an access token, which the Firestore REST API
   accepts. Nothing is written to disk except the hashes.

   WHAT NEVER HAPPENS HERE
   - the plaintext code is never stored, only sha256 of it;
   - the plaintext is printed once, to this terminal, and not logged;
   - nothing reads an existing hash back out to show it.

   USAGE
     # First run: generate both codes and print them once.
     node tools/bootstrap-access.mjs --key ./service-account.json

     # Use codes you already chose (16+ characters, please).
     node tools/bootstrap-access.mjs --key ./sa.json --shop "..." --admin "..."

     # Change a code later. The old one stops working immediately.
     node tools/bootstrap-access.mjs --key ./sa.json --rotate --shop "..."

     # Recovery when the admin code is lost: mint a grant by hand.
     node tools/bootstrap-access.mjs --list-grants
     node tools/bootstrap-access.mjs --grant <uid> --role admin
     node tools/bootstrap-access.mjs --revoke <uid>

   The service-account key must never be committed. See .gitignore.
   ========================================================= */

import { createSign, createHash, randomInt } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------
   Argument parsing
   ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[arg.slice(2)] = true;
    } else {
      out[arg.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function die(message) {
  console.error("\n  " + message + "\n");
  process.exit(1);
}

function usage() {
  console.log(`
  TrustX Ledger — access codes

    node tools/bootstrap-access.mjs --key <service-account.json> [options]

    --project <id>     Firebase project id (default: FIREBASE_PROJECT_ID, else
                       the projectId in js/firebase.js)
    --key <path>       service-account JSON (default: GOOGLE_APPLICATION_CREDENTIALS)
    --shop <code>      shop code (default: generate a strong one and print it)
    --admin <code>     admin code (default: generate a strong one and print it)
    --rotate           required to replace codes that already exist
    --list             show which codes are set, without revealing them
    --grant <uid>      mint/repair accessGrants/<uid> (bypasses the rules)
    --role <shop|admin> role for --grant (default: shop)
    --revoke <uid>     set accessGrants/<uid>.active = false
    --list-grants      list access grants (uids, roles, active)
    --emulator         target the local Firestore emulator instead of production
    --allow-weak       permit a code shorter than 16 characters (not advised)

    First run:  node tools/bootstrap-access.mjs --key ./sa.json
    Recovery:   node tools/bootstrap-access.mjs --key ./sa.json --list-grants
`);
}

/* ------------------------------------------------------------------
   Codes: normalization and hashing
   Mirrors normalizeCode() in js/auth.js exactly. If these two ever
   disagree, sign-in breaks for everyone — which is why both spell the
   rule out again instead of sharing code across a browser/Node boundary.
   ------------------------------------------------------------------ */

export function normalizeCode(input) {
  return String(input == null ? "" : input).toUpperCase().replace(/\s+/g, "").trim();
}

export function hashCode(code) {
  return createHash("sha256").update(normalizeCode(code), "utf8").digest("hex");
}

/* A code someone has to read off a screen and retype on a phone. Ambiguous
   characters (I/1, O/0) are left out, and 20 characters of a 32-symbol
   alphabet is ~100 bits — far past anything a person can guess online. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_LENGTH = 20;
const MIN_LENGTH = 16;

function generateCode(length = DEFAULT_LENGTH) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/* ------------------------------------------------------------------
   Auth: service account -> Google access token -> Firestore REST
   ------------------------------------------------------------------ */

const SCOPE = "https://www.googleapis.com/auth/datastore";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signJwt(claims, privateKey) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

async function accessTokenFromKey(keyPath) {
  if (!keyPath) die("No service-account key. Pass --key <path> or set GOOGLE_APPLICATION_CREDENTIALS.");
  if (!existsSync(keyPath)) die(`Service-account key not found: ${keyPath}`);

  let key;
  try {
    key = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch (err) {
    die(`Could not read the service-account key (${err.message}).`);
  }
  if (!key.client_email || !key.private_key) {
    die("That file is not a Firebase service-account key (no client_email / private_key).");
  }

  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    {
      iss: key.client_email,
      sub: key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    },
    key.private_key
  );

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    die(`Google rejected the key (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()).access_token;
}

/* ------------------------------------------------------------------
   Firestore REST
   ------------------------------------------------------------------ */

function projectId() {
  if (typeof args.project === "string") return args.project;
  if (process.env.FIREBASE_PROJECT_ID) return process.env.FIREBASE_PROJECT_ID;
  /* Fall back to the id the app itself is configured for, so the default
     "just run it" path cannot target the wrong project. */
  try {
    const src = readFileSync(join(ROOT, "js", "firebase.js"), "utf8");
    const m = src.match(/projectId:\s*"([^"]+)"/);
    if (m) return m[1];
  } catch (err) {
    /* fall through */
  }
  die("No project id. Pass --project <id> or set FIREBASE_PROJECT_ID.");
  return "";
}

function firestoreBase() {
  const project = projectId();
  /* The emulator takes "Bearer owner" and needs no credentials at all. */
  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  if (emulator) return { base: `http://${emulator}/v1`, project, emulator: true };
  return { base: "https://firestore.googleapis.com/v1", project, emulator: false };
}

async function makeClient() {
  const { base, project, emulator } = firestoreBase();
  const token = emulator ? "owner" : await accessTokenFromKey(args.key || process.env.GOOGLE_APPLICATION_CREDENTIALS);
  return {
    project,
    emulator,
    url: (path) => `${base}/projects/${project}/databases/(default)/documents/${path}`,
    async get(path) {
      const res = await fetch(`${base}/projects/${project}/databases/(default)/documents/${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
      return res.json();
    },
    async patch(path, fields) {
      const res = await fetch(`${base}/projects/${project}/databases/(default)/documents/${path}?updateMask.fieldPaths=${Object.keys(fields).join("&updateMask.fieldPaths=")}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
      return res.json();
    },
    async create(path, fields) {
      const res = await fetch(`${base}/projects/${project}/databases/(default)/documents/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
      return res.json();
    },
    async list(collection) {
      const res = await fetch(`${base}/projects/${project}/databases/(default)/documents/${collection}?pageSize=1000`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`LIST ${collection} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
      return res.json();
    },
    async delete(path) {
      const res = await fetch(`${base}/projects/${project}/databases/(default)/documents/${path}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`DELETE ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    },
  };
}

/* Firestore REST wire values. */
const str = (v) => ({ stringValue: v });
const ts = (d) => ({ timestampValue: (d || new Date()).toISOString() });
const bool = (v) => ({ booleanValue: v });
/* `value` may be an ISO string or a Date; both become a timestamp, never a
   string, so the stored shape does not change when a code is rotated. */
const tsOf = (value) => ({ timestampValue: value instanceof Date ? value.toISOString() : value });

function unescape(v) {
  return v.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function field(doc, name) {
  const f = doc?.fields?.[name];
  if (!f) return undefined;
  if (f.stringValue !== undefined) return unescape(f.stringValue);
  if (f.timestampValue !== undefined) return f.timestampValue;
  if (f.booleanValue !== undefined) return f.booleanValue;
  return undefined;
}

/* ------------------------------------------------------------------
   Commands
   ------------------------------------------------------------------ */

const SECRET_PATHS = { shop: "securitySecrets/shop", admin: "securitySecrets/admin" };

async function cmdListSecrets(fs) {
  console.log(`\n  Access codes in project "${fs.project}"${fs.emulator ? " (EMULATOR)" : ""}\n`);
  for (const [scope, path] of Object.entries(SECRET_PATHS)) {
    const doc = await fs.get(path);
    if (!doc) {
      console.log(`    ${scope.padEnd(6)} NOT SET`);
      continue;
    }
    const rotated = field(doc, "rotatedAt") || field(doc, "createdAt") || "unknown";
    console.log(`    ${scope.padEnd(6)} set   (hash ${String(field(doc, "codeHash") || "").slice(0, 8)}…, last changed ${rotated})`);
  }
  console.log("\n  The codes themselves are never stored and cannot be read back.\n");
}

async function cmdBootstrap(fs) {
  const existing = {};
  for (const [scope, path] of Object.entries(SECRET_PATHS)) {
    existing[scope] = await fs.get(path);
  }
  const already = Object.keys(existing).filter((s) => existing[s]);

  if (already.length && !args.rotate) {
    die(
      `${already.join(" and ")} code(s) already exist. Replacing one locks out every\n` +
        `     browser that is relying on it, so re-run with --rotate when that is what\n` +
        `     you intend. (Existing browsers do NOT need to re-enter the code: their\n` +
        `     grant is separate and stays valid.)`
    );
  }

  const created = [];
  const changed = [];
  for (const scope of ["shop", "admin"]) {
    const supplied = typeof args[scope] === "string" ? normalizeCode(args[scope]) : "";
    if (supplied && supplied.length < MIN_LENGTH && !args["allow-weak"]) {
      die(`The ${scope} code is ${supplied.length} characters; ${MIN_LENGTH} is the minimum (or pass --allow-weak and accept the risk).`);
    }
    const code = supplied || generateCode();
    const doc = {
      codeHash: str(hashCode(code)),
      createdAt: existing[scope]
        ? tsOf(field(existing[scope], "createdAt") || new Date().toISOString())
        : ts(),
      rotatedAt: ts(),
      rotatedBy: str("tools/bootstrap-access.mjs"),
    };
    if (existing[scope]) {
      await fs.patch(SECRET_PATHS[scope], doc);
      changed.push(scope);
    } else {
      await fs.create(SECRET_PATHS[scope], doc);
      created.push(scope);
    }
    /* Printed once, to this terminal. Not written anywhere, not logged. */
    console.log(`\n    ${scope.toUpperCase()} CODE:  ${code}\n`);
  }

  if (created.length) console.log(`  Set: ${created.join(", ")}`);
  if (changed.length) console.log(`  Rotated: ${changed.join(", ")}`);
  console.log(`
  Write these down now — they cannot be displayed again. If you lose one:
    - shop code: any trusted browser can re-enroll with the admin code below.
    - admin code: re-run this tool with --grant <uid> --role admin to mint a
      grant by hand, then rotate the admin code.
`);
}

async function cmdListGrants(fs) {
  const res = await fs.list("accessGrants");
  const docs = res.documents || [];
  console.log(`\n  Access grants in project "${fs.project}"\n`);
  if (!docs.length) console.log("    (none — no browser has ever entered the shop code)");
  for (const doc of docs) {
    const uid = doc.name.split("/documents/")[1].split("/").pop();
    const role = field(doc, "role") || "shop";
    const active = field(doc, "active") === true;
    const label = field(doc, "label") || "";
    const used = field(doc, "lastUsedAt") || "never";
    console.log(
      `    ${uid}\n` +
        `        ${active ? "active" : "REVOKED"} · ${role} · last used ${used}${label ? ` · ${label}` : ""}`
    );
  }
  console.log("");
}

async function cmdGrant(fs) {
  const uid = args.grant;
  if (typeof uid !== "string" || !uid) die("--grant needs a uid. Run --list-grants to see them.");
  const role = args.role === "admin" ? "admin" : "shop";
  const now = ts();
  const existing = await fs.get(`accessGrants/${uid}`);

  if (existing) {
    await fs.patch(`accessGrants/${uid}`, {
      active: bool(true),
      role: str(role),
      updatedAt: now,
      updatedBy: str("tools/bootstrap-access.mjs"),
    });
    console.log(`\n  accessGrants/${uid} is now active with role "${role}".\n`);
    return;
  }

  await fs.create(`accessGrants/${uid}`, {
    active: bool(true),
    role: str(role),
    label: str("Recovered by bootstrap tool"),
    client: { mapValue: { fields: { ua: str("recovered"), lang: str("") } } },
    lastUsedAt: now,
    createdAt: now,
    createdBy: str(uid),
    updatedAt: now,
    updatedBy: str("tools/bootstrap-access.mjs"),
  });
  console.log(`\n  accessGrants/${uid} created (active, role "${role}").\n`);
  console.log("  That browser can now open the ledger without any code.\n");
}

async function cmdRevoke(fs) {
  const uid = args.revoke;
  if (typeof uid !== "string" || !uid) die("--revoke needs a uid.");
  const existing = await fs.get(`accessGrants/${uid}`);
  if (!existing) die(`No grant for ${uid}.`);
  await fs.patch(`accessGrants/${uid}`, {
    active: bool(false),
    updatedAt: ts(),
    updatedBy: str("tools/bootstrap-access.mjs"),
  });
  console.log(`\n  accessGrants/${uid} is now REVOKED — every Firestore read and write for\n  that browser is denied from its next request.\n`);
}

async function main() {
  if (args.help || Object.keys(args).length === 0) {
    usage();
    return;
  }
  const fs = await makeClient();
  if (args.list) return cmdListSecrets(fs);
  if (args["list-grants"]) return cmdListGrants(fs);
  if (args.grant) return cmdGrant(fs);
  if (args.revoke) return cmdRevoke(fs);
  return cmdBootstrap(fs);
}

/* Only run when invoked as a command, so a test can import hashCode() and
   normalizeCode() without this script trying to talk to a project.
   Both sides are normalized to forward slashes: process.argv[1] is a
   Windows path here, import.meta.url is not. */
const toPath = (p) => (p || "").replace(/\\/g, "/");
const invokedDirectly = Boolean(process.argv[1]) && toPath(fileURLToPath(import.meta.url)) === toPath(process.argv[1]);

if (invokedDirectly) {
  main().catch((err) => {
    die(err && err.message ? err.message : String(err));
  });
}
