// tools/migrate-to-rtdb.mjs
// Transfers 'settings', 'enrollments', and 'devices' from Cloud Firestore to Realtime Database.
// Keeps 'services' and 'transactions' / 'dayHeads' in Cloud Firestore.

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const userProfile = process.env.USERPROFILE || process.env.HOME;
const tokenPath = path.join(userProfile, '.config', 'configstore', 'firebase-tools.json');
if (!fs.existsSync(tokenPath)) {
  console.error('Firebase tools credentials not found at:', tokenPath);
  process.exit(1);
}

const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8')).tokens;
const token = tokenData.access_token;
const PROJECT_ID = 'trustxplpy';
const RTDB_URL = 'https://trustxplpy-default-rtdb.firebaseio.com';

function httpsRequest(url, options = {}, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : null;
          resolve({ status: res.statusCode, data: parsed, raw: body });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }
    req.end();
  });
}

function parseFirestoreValue(v) {
  if (v === null || v === undefined) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return new Date(v.timestampValue).getTime();
  if ('mapValue' in v) {
    const res = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) {
      res[k] = parseFirestoreValue(val);
    }
    return res;
  }
  if ('arrayValue' in v) {
    return (v.arrayValue.values || []).map(parseFirestoreValue);
  }
  if ('nullValue' in v) return null;
  return v;
}

function parseFirestoreDoc(doc) {
  const res = {};
  for (const [k, v] of Object.entries(doc.fields || {})) {
    res[k] = parseFirestoreValue(v);
  }
  return res;
}

async function fetchFirestoreCollection(collectionName) {
  let allDocs = [];
  let pageToken = '';
  do {
    const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collectionName}?pageSize=100${pageParam}`;
    const res = await httpsRequest(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.status !== 200) {
      throw new Error(`Failed to fetch ${collectionName} from Firestore (${res.status}): ${res.raw}`);
    }
    const docs = res.data.documents || [];
    allDocs = allDocs.concat(docs);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  const result = {};
  for (const d of allDocs) {
    const docId = d.name.split('/').pop();
    result[docId] = parseFirestoreDoc(d);
  }
  return result;
}

async function writeToRtdb(path, data) {
  const url = `${RTDB_URL}/${path}.json`;
  const res = await httpsRequest(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  }, data);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Failed to write to RTDB at ${path} (${res.status}): ${res.raw}`);
  }
  return res.data;
}

async function readFromRtdb(path) {
  const url = `${RTDB_URL}/${path}.json`;
  const res = await httpsRequest(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return res.data;
}

async function migrate() {
  console.log('--- Starting Migration from Firestore to Realtime Database ---');

  // 1. Settings
  console.log('\n[1/3] Reading settings from Firestore...');
  const settings = await fetchFirestoreCollection('settings');
  console.log(`Found ${Object.keys(settings).length} settings documents:`, Object.keys(settings));
  console.log('Writing settings to Realtime Database...');
  await writeToRtdb('settings', settings);
  const verifySettings = await readFromRtdb('settings');
  console.log('Verified settings in RTDB:', Object.keys(verifySettings || {}));

  // 2. Enrollments
  console.log('\n[2/3] Reading enrollments from Firestore...');
  const enrollments = await fetchFirestoreCollection('enrollments');
  console.log(`Found ${Object.keys(enrollments).length} enrollments documents`);
  console.log('Writing enrollments to Realtime Database...');
  await writeToRtdb('enrollments', enrollments);
  const verifyEnrollments = await readFromRtdb('enrollments');
  console.log(`Verified ${Object.keys(verifyEnrollments || {}).length} enrollments in RTDB`);

  // 3. Devices
  console.log('\n[3/3] Reading devices from Firestore...');
  const devices = await fetchFirestoreCollection('devices');
  console.log(`Found ${Object.keys(devices).length} devices documents`);
  console.log('Writing devices to Realtime Database...');
  await writeToRtdb('devices', devices);
  const verifyDevices = await readFromRtdb('devices');
  console.log(`Verified ${Object.keys(verifyDevices || {}).length} devices in RTDB`);

  console.log('\n=== Migration completed successfully! ===');
  console.log('Collections now in Realtime Database: settings, enrollments, devices');
  console.log('Kept in Cloud Firestore: services, transactions / dayHeads');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
