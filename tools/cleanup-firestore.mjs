// tools/cleanup-firestore.mjs
// Deletes the collections that have been migrated to Realtime Database:
//   devices, enrollments, settings
// Leaves intact: services, dayHeads (transactions)

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const userProfile = process.env.USERPROFILE || process.env.HOME;
const tokenPath = path.join(userProfile, '.config', 'configstore', 'firebase-tools.json');
const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8')).tokens;
const token = tokenData.access_token;

const PROJECT_ID = 'trustxplpy';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function httpsRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, raw: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function listDocIds(collection, pageToken = '') {
  const ptParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
  const url = `${BASE}/${collection}?pageSize=100&mask.fieldPaths=__name__${ptParam}`;
  const res = await httpsRequest(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const parsed = JSON.parse(res.raw);
  const ids = (parsed.documents || []).map(d => d.name.split('/').pop());
  return { ids, nextPageToken: parsed.nextPageToken };
}

async function deleteDoc(collection, docId) {
  const url = `${BASE}/${collection}/${docId}`;
  const res = await httpsRequest(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (res.status !== 200 && res.status !== 404) {
    throw new Error(`DELETE ${collection}/${docId} → ${res.status}: ${res.raw}`);
  }
  return res.status;
}

async function deleteCollection(collection) {
  let total = 0;
  let pageToken = '';
  do {
    const { ids, nextPageToken } = await listDocIds(collection, pageToken);
    if (ids.length === 0) break;
    for (const id of ids) {
      const status = await deleteDoc(collection, id);
      process.stdout.write(`  deleted ${collection}/${id} (${status})\n`);
      total++;
    }
    pageToken = nextPageToken;
  } while (pageToken);
  return total;
}

const COLLECTIONS_TO_DELETE = ['devices', 'enrollments', 'settings'];

console.log('--- Removing migrated collections from Cloud Firestore ---\n');
for (const col of COLLECTIONS_TO_DELETE) {
  console.log(`Deleting ${col}...`);
  const n = await deleteCollection(col);
  console.log(`  ✓ ${n} documents deleted from ${col}\n`);
}
console.log('=== Done. Firestore now contains only: services, dayHeads ===');
