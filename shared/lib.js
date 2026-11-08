'use strict';
// Helpers shared by the server, the virtual device and the attack script.
const crypto = require('node:crypto');
const https = require('node:https');

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

// Constant-time comparison so an attacker can't guess a signature byte by byte.
function safeEqualHex(a, b) {
  const A = Buffer.from(String(a || ''), 'hex');
  const B = Buffer.from(String(b || ''), 'hex');
  return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B);
}

// One device secret -> two separate keys (never reuse one key for two jobs):
//   encKey: AES-128 key that encrypts the payload (the "symmetric encryption" in the proposal)
//   macKey: HMAC-SHA256 key that signs the request
function deviceKeys(secretHex) {
  const ikm = Buffer.from(secretHex, 'hex');
  const derive = (info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, len));
  return { encKey: derive('soil-iot enc v1', 16), macKey: derive('soil-iot mac v1', 32) };
}

// AES-128-GCM. GCM also detects any change to the ciphertext.
function encryptPayload(encKey, obj, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-128-gcm', encKey, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { v: 1, alg: 'AES-128-GCM', iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

function decryptPayload(encKey, env, aad) {
  const d = crypto.createDecipheriv('aes-128-gcm', encKey, Buffer.from(env.iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]).toString('utf8'));
}

// What the device signs: method, path, time, a one-time nonce and a hash of the (encrypted) body.
function signingString(method, path, ts, nonce, body) {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return [method, path, ts, nonce, bodyHash].join('\n');
}

// Small HTTPS client. `ca` pins the server's own certificate (MITM protection).
function request(url, { method = 'GET', headers = {}, body, ca } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, ca }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Encrypt, then sign. `payload` is { type: 'reading' | 'motion', ... }.
function signedTelemetry(device, payload, { ts = Date.now(), nonce = crypto.randomBytes(16).toString('hex'), plaintext = false } = {}) {
  const { encKey, macKey } = deviceKeys(device.secret);
  const body = JSON.stringify(plaintext ? payload : encryptPayload(encKey, payload, device.deviceId));
  const signature = hmac(macKey, signingString('POST', '/api/device/telemetry', ts, nonce, body));
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': device.deviceId,
      'X-Timestamp': String(ts),
      'X-Nonce': nonce,
      'X-Signature': signature,
    },
  };
}

module.exports = { hmac, safeEqualHex, deviceKeys, encryptPayload, decryptPayload, signingString, request, signedTelemetry };
