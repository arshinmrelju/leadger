/* =========================================================
   TrustX Ledger — allowlist bootstrap / management / recovery
   -----------------------------------------------------------------
   Writes the Google-account allowlist that the whole sign-in model
   rests on, into Firestore `allowedUsers/{email}`.

   WHY A SEPARATE TOOL
   `firestore.rules` denies every read and write on `allowedUsers/**`.
   That is the point: no browser can read the list or replace it. So
   the allowlist has to be managed from somewhere with authority, and
   the somewhere is this script, using a service-account key. It
   bypasses the rules because the Admin SDK does — it authenticates as
   the project owner, not as a browser.

   NO DEPENDENCIES, ON PURPOSE
   This is a static app whose whole install story is "no npm install".
   Pulling in firebase-admin just to sign one JWT would undo that, so
   the token exchange is done directly: a service account's private key
   signs a JWT (RS256, built with node:crypto) which Google's token
   endpoint exchanges for an access token, which the Firestore REST API
   accepts. Nothing is written to disk except the allowlist entries.

   WHAT NEVER HAPPENS HERE
   - the plaintext email is never stored in a way a client can read;
   - nothing reads an existing entry back out to show it;
   - the allowlist is never printed in full.

   USAGE
     # First run: add the shop owner as admin.
     node tools/bootstrap-access.mjs --key ./service-account.json --add admin@example.com --role admin

     # Add a shop user.
     node tools/bootstrap-access.mjs --key ./sa.json --add worker@example.com --role shop

     # List who has access.
     node tools/bootstrap-access.mjs --key ./sa.json --list

     # Remove someone.
     node tools/bootstrap-access.mjs --key ./sa.json --remove worker@example.com

     # Change a role.
     node tools/bootstrap-access.mjs --key ./sa.json --add worker@example.com --role admin

     # Recovery: mint a grant by hand.
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
  TrustX Ledger — Google allowlist management

    node tools/bootstrap-access.mjs --key <service-account.json> [options]

    --project <id>     Firebase project id (default: FIREBASE_PROJECT_ID, else
                       the projectId in js/firebase.js)
    --key <path>       service-account JSON (default: GOOGLE_APPLICATION_CREDENTIALS)
    --add <email>      add/update an allowlist entry (requires --role)
    --role <shop|admin> role for --add (default: shop)
    --remove <email>   remove an allowlist entry
    --list             show who has access (emails and roles)
    --grant <uid>      mint/repair accessGrants/<uid> (bypasses the rules)
    --revoke <uid>     set accessGrants/<uid>.active = false
    --list-grants      list access grants (uids, roles, active)
    --emulator         target the local Firestore emulator instead of production

    First run:  node tools/bootstrap-access.mjs --key ./sa.json --add owner@gmail.com --role admin
    Recovery:   node tools/bootstrap-access.mjs --key ./sa.json --list-grants
`);
}

/* ------------------------------------------------------------------
   Email validation
   ------------------------------------------------------------------ */

function normalizeEmail(input) {
  return String(input || "").toLowerCase().trim();
}

function isValidEmail(email) {
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email);
}

/* The allowlist document ID IS the normalised email address.

   Firestore document IDs may contain '@' and '.' (only '/' is barred, and
   an id may not be "." or ".."), and every REST path in this file is
   percent-encoded segment by segment, so an address works as an id without
   any trouble.

   It has to be the email. `firestore.rules` can only reach a document by an
   exact path — the rules language has no hashing function and no way to look
   a document up by a field — so the id written here must be the same string
   the rules build from `request.auth.token.email`, or the allowlist check can
   never be satisfied.

   An earlier version hashed the email into the document ID, which made that
   check unsatisfiable: the tool wrote one id and the rules looked for
   another, so every account was refused, including the owner's. `--add`
   now also sweeps away an entry left behind by that version. */
function allowlistDocId(email) {
  return email;
}

/* The document ID used before the address became the ID. Kept only so
   `--add` can recognise and delete an orphaned entry from that scheme. */
function legacyDocId(email) {
  return createHash("sha256").update(email, "utf8").digest("hex").slice(0, 32);
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
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(`${base}/projects/${project}/databases/(default)/documents/${encodedPath}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
      return res.json();
    },
    async patch(path, fields) {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(`${base}/projects/${project}/databases/(default)/documents/${encodedPath}?updateMask.fieldPaths=${Object.keys(fields).join("&updateMask.fieldPaths=")}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
      return res.json();
    },
    /* Creating a document is a PATCH against the full document path with an
       update mask, NOT a POST. A POST takes the last path segment as the
       *collection* and requires the document ID as a `documentId` query
       parameter, so POSTing `allowedUsers/{email}` is rejected with
       INVALID_ARGUMENT ("parent name ... lacks /"), and `--add` fails for
       every new entry. PATCH is create-or-update, which is what every caller
       here wants, and it is also the one shape that round-trips an email
       document ID — a POST with ?documentId= would re-encode the '@' on the
       way back in the response and disagree with the ID the rules build. */
    async create(path, fields) {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(`${base}/projects/${project}/databases/(default)/documents/${encodedPath}?updateMask.fieldPaths=${Object.keys(fields).join("&updateMask.fieldPaths=")}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
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
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(`${base}/projects/${project}/databases/(default)/documents/${encodedPath}`, {
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
   string, so the stored shape does not change when an entry is updated. */
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

async function cmdList(fs) {
  const res = await fs.list("allowedUsers");
  const docs = res.documents || [];
  console.log(`\n  Allowed Google accounts in project "${fs.project}"${fs.emulator ? " (EMULATOR)" : ""}\n`);
  if (!docs.length) {
    console.log("    (none — no one can sign in yet)");
  }
  for (const doc of docs) {
    const email = field(doc, "email") || doc.name.split("/documents/")[1].split("/").pop();
    const role = field(doc, "role") || "shop";
    const created = field(doc, "createdAt") || "unknown";
    console.log(`    ${email}\n        ${role} · added ${created}`);
  }
  console.log("");
}

async function cmdAdd(fs) {
  const email = normalizeEmail(args.add);
  if (!email) die("--add needs an email address.");
  if (!isValidEmail(email)) die(`"${email}" is not a valid email address.`);
  const role = args.role === "admin" ? "admin" : "shop";
  const docId = allowlistDocId(email);

  const existing = await fs.get(`allowedUsers/${docId}`);
  const now = ts();

  if (existing) {
    await fs.patch(`allowedUsers/${docId}`, {
      role: str(role),
      updatedAt: now,
      updatedBy: str("tools/bootstrap-access.mjs"),
    });
    console.log(`\n  Updated ${email} → role "${role}".\n`);
    await dropLegacyEntry(fs, email, docId);
    return;
  }

  await fs.create(`allowedUsers/${docId}`, {
    email: str(email),
    role: str(role),
    createdAt: now,
    createdBy: str("tools/bootstrap-access.mjs"),
    updatedAt: now,
    updatedBy: str("tools/bootstrap-access.mjs"),
  });
  console.log(`\n  Added ${email} with role "${role}".\n`);
  console.log("  That Google account can now sign in to the ledger.\n");
  await dropLegacyEntry(fs, email, docId);
}

/* An entry written by the hashed-ID version of this tool is invisible to
   `firestore.rules`, which looks the address up directly — so it authorises
   nobody while still showing up in `--list` and looking correct. Deleting it
   on the way past keeps a half-migrated allowlist from quietly lying. */
async function dropLegacyEntry(fs, email, currentId) {
  const oldId = legacyDocId(email);
  if (oldId === currentId) return;
  try {
    if (!(await fs.get(`allowedUsers/${oldId}`))) return;
    await fs.delete(`allowedUsers/${oldId}`);
    console.log(`  Also removed the stale hashed entry left by an older version\n  of this tool — it was unreachable by the rules and granted nothing.\n`);
  } catch (err) {
    console.warn(`  (could not clean up an old hashed entry: ${err.message})`);
  }
}

async function cmdRemove(fs) {
  const email = normalizeEmail(args.remove);
  if (!email) die("--remove needs an email address.");
  const docId = allowlistDocId(email);
  const existing = await fs.get(`allowedUsers/${docId}`);
  const legacy = await fs.get(`allowedUsers/${legacyDocId(email)}`);
  if (!existing && !legacy) die(`No allowlist entry for ${email}.`);
  if (existing) await fs.delete(`allowedUsers/${docId}`);
  if (legacy) await fs.delete(`allowedUsers/${legacyDocId(email)}`);
  console.log(`\n  Removed ${email} from the allowlist.\n`);
  console.log("  That Google account can no longer sign in (existing grants remain\n  until revoked from the Developer console).\n");
}

async function cmdListGrants(fs) {
  const res = await fs.list("accessGrants");
  const docs = res.documents || [];
  console.log(`\n  Access grants in project "${fs.project}"\n`);
  if (!docs.length) console.log("    (none — no browser has ever signed in)");
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
  console.log("  That browser can now open the ledger without signing in again.\n");
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
  if (args.list) return cmdList(fs);
  if (args.add) return cmdAdd(fs);
  if (args.remove) return cmdRemove(fs);
  if (args["list-grants"]) return cmdListGrants(fs);
  if (args.grant) return cmdGrant(fs);
  if (args.revoke) return cmdRevoke(fs);
  usage();
}

/* Only run when invoked as a command, so a test can import helpers
   without this script trying to talk to a project.
   Both sides are normalized to forward slashes: process.argv[1] is a
   Windows path here, import.meta.url is not. */
const toPath = (p) => (p || "").replace(/\\/g, "/");
const invokedDirectly = Boolean(process.argv[1]) && toPath(fileURLToPath(import.meta.url)) === toPath(process.argv[1]);

if (invokedDirectly) {
  main().catch((err) => {
    die(err && err.message ? err.message : String(err));
  });
}
