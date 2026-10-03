#!/usr/bin/env node
/* Mint (or clear) the office bridge's custom claim.
   -------------------------------------------------------------------
   The Flutter bridge on the office phone signs in ANONYMOUSLY, so it
   carries no allowlist entry, no accessGrant and no power over the
   money. What it does carry is one custom claim — { "bridge": true } —
   and firestore.rules' isBridge() is the only place that claim is
   believed. Clients cannot forge claims: they can only be written
   here, with the project owner's service-account key, exactly like
   tools/bootstrap-access.mjs writes the allowlist.

   Usage:
     node tools/set-bridge-claim.mjs --key sa.json --uid <bridge-uid>
     node tools/set-bridge-claim.mjs --key sa.json --uid <bridge-uid> --clear

   The bridge UID is shown on the bridge app's setup screen. After
   minting, restart the bridge (or press Check Now) so it force-
   refreshes its ID token — claims only appear on a freshly issued
   token. To lock a lost phone out, re-run with --clear (or delete the
   anonymous user in the Firebase console): the next claim check fails
   closed.

   No npm dependencies — the same hand-rolled service-account JWT
   exchange as bootstrap-access.mjs, against the Identity Toolkit
   Admin REST endpoint (accounts:update), which is exactly what the
   Admin SDK's setCustomUserClaims() calls under the hood.
   The token and the key never leave this process and are never
   printed.
*/
import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = "https://www.googleapis.com/auth/identitytoolkit";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPDATE_URL = "https://identitytoolkit.googleapis.com/v1/accounts:update";

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--clear") args.clear = true;
  else if (a === "--help" || a === "-h") args.help = true;
  else if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
}

if (args.help) {
  console.log(
    "Usage:\n" +
    "  node tools/set-bridge-claim.mjs --key <service-account.json> --uid <bridge-uid>\n" +
    "  node tools/set-bridge-claim.mjs --key <service-account.json> --uid <bridge-uid> --clear\n\n" +
    "Mints the { bridge: true } custom claim the office bridge's Firestore\n" +
    "rules require. --clear removes it (a lost phone fails closed)."
  );
  process.exit(0);
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signJwt(claims, privateKey) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signer = createSign("RSA-SHA256");
  signer.update(header + "." + payload);
  return header + "." + payload + "." + signer.sign(privateKey).toString("base64url");
}

async function accessTokenFromKey(keyPath) {
  if (!keyPath) die("No service-account key. Pass --key <path> or set GOOGLE_APPLICATION_CREDENTIALS.");
  if (!existsSync(keyPath)) die("Service-account key not found: " + keyPath);

  let key;
  try {
    key = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch (err) {
    die("Could not read the service-account key (" + err.message + ").");
  }
  if (!key.client_email || !key.private_key) {
    die("That file is not a Firebase service-account key (no client_email / private_key).");
  }

  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    { iss: key.client_email, sub: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
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
    die("Google rejected the key (" + res.status + "): " + (await res.text()).slice(0, 300));
  }
  return (await res.json()).access_token;
}

async function main() {
  const uid = typeof args.uid === "string" ? args.uid.trim() : "";
  if (!uid) die("Missing --uid. The bridge app's setup screen shows its UID; paste it here.");

  const token = await accessTokenFromKey(args.key || process.env.GOOGLE_APPLICATION_CREDENTIALS);

  /* customAttributes is a JSON STRING on the wire — that is how the
     Admin SDK sends it too. Replacing the whole map is deliberate:
     the bridge user holds no other claims, so "{}" is a clean slate. */
  const body = {
    localId: uid,
    customAttributes: args.clear ? "{}" : JSON.stringify({ bridge: true }),
  };

  const res = await fetch(UPDATE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    die("Identity Toolkit refused the update (" + res.status + "): " + text.slice(0, 400));
  }

  const verb = args.clear ? "cleared on" : "minted on";
  console.log("Bridge claim " + verb + " user " + uid + ".");
  console.log("");
  console.log("Next steps:");
  console.log("  1. In the bridge app, press Check Now (or restart it) so it");
  console.log("     force-refreshes its ID token — a claim only appears on a");
  console.log("     freshly issued token.");
  console.log("  2. To lock a device out later, re-run with --clear: the bridge");
  console.log("     then fails closed on its next Firestore request.");
}

main().catch((err) => die("Failed: " + (err && err.message ? err.message : String(err))));
