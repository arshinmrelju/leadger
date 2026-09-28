import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FIREBASE_CONFIG } from '../js/firebase.js';

function request(url, options = {}, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body), raw: body });
        } catch (_) {
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

async function test() {
  console.log('1. Signing in anonymously via REST...');
  const authRes = await request(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_CONFIG.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    { returnSecureToken: true }
  );

  const { idToken, localId: uid } = authRes.data;
  console.log('Signed in as uid:', uid);

  // Read settings/security using admin token
  const userProfile = process.env.USERPROFILE || process.env.HOME;
  const tokenPath = path.join(userProfile, '.config', 'configstore', 'firebase-tools.json');
  const adminToken = JSON.parse(fs.readFileSync(tokenPath, 'utf8')).tokens.access_token;

  const secRes = await request(
    `https://trustxplpy-default-rtdb.firebaseio.com/settings/security.json?access_token=${adminToken}`,
    { method: 'GET' }
  );
  console.log('2. Current settings/security in DB:', secRes.raw);

  // Now test writing to enrollments as this anonymous user
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  console.log('3. Generated nonce:', nonce);

  const payload = {
    scope: 'shop',
    verifiedCode: 'TRUSTX',
    createdAt: { '.sv': 'timestamp' },
    createdBy: uid,
    used: false
  };

  const writeRes = await request(
    `https://trustxplpy-default-rtdb.firebaseio.com/enrollments/${nonce}.json?auth=${idToken}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    },
    payload
  );

  console.log('4. Enrollment write status:', writeRes.status, writeRes.raw);

  // Now test writing to devices as this anonymous user!
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const deviceToken = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = crypto.createHash('sha256').update(deviceToken).digest('hex');
  console.log('5. Testing devices write at devices/' + hash);

  const devicePayload = {
    tokenHash: hash,
    uid: uid,
    label: 'Test device',
    client: { ua: 'test', lang: 'en' },
    network: { type: '', saveData: false, online: true },
    createdAt: { '.sv': 'timestamp' },
    createdBy: uid,
    lastUsedAt: { '.sv': 'timestamp' },
    lastUsedNetwork: { type: '', saveData: false, online: true },
    active: true,
    enrollmentId: nonce
  };

  const deviceRes = await request(
    `https://trustxplpy-default-rtdb.firebaseio.com/devices/${hash}.json?auth=${idToken}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    },
    devicePayload
  );
  console.log('6. Devices write status:', deviceRes.status, deviceRes.raw);

  // Clean up
  await request(`https://trustxplpy-default-rtdb.firebaseio.com/enrollments/${nonce}.json?access_token=${adminToken}`, { method: 'DELETE' });
  await request(`https://trustxplpy-default-rtdb.firebaseio.com/devices/${hash}.json?access_token=${adminToken}`, { method: 'DELETE' });
  console.log('7. Cleaned up.');
}

test();
