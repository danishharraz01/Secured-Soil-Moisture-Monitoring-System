'use strict';
// Restores a cloud backup using the OFFLINE private key.
// Usage: npm run restore -- cloud/backup-....json
// Checks: Ed25519 signature (made by our server?), RSA unwrap, AES-GCM tag (unchanged?), SHA-256.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonical } = require('../server/backup');

const ROOT = path.join(__dirname, '..');
const cloudDir = path.join(ROOT, 'cloud');
const file = process.argv[2] || (fs.existsSync(cloudDir)
  ? fs.readdirSync(cloudDir).filter((f) => f.startsWith('backup-')).sort().map((f) => `cloud/${f}`).pop()
  : undefined);
if (!file) {
  console.error('No backup yet. Backups run every 10 minutes, or press "Back up to cloud now" in the app as admin.');
  process.exit(1);
}

const env = JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
const serverPub = fs.readFileSync(path.join(ROOT, 'server', 'server-public.pem'));
const privateKey = fs.readFileSync(path.join(ROOT, 'offline-keys', 'backup-private.pem'));

const step = (ok, text) => { console.log(`${ok ? 'OK  ' : 'FAIL'}  ${text}`); if (!ok) process.exit(1); };

console.log(`Restoring ${file}\n`);
step(crypto.verify(null, canonical(env), serverPub, Buffer.from(env.signature, 'base64')), 'Signature valid: backup was made by our server and not modified');

let dataKey;
try {
  dataKey = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(env.wrappedKey, 'base64'));
} catch { step(false, 'Could not unwrap the AES key (wrong private key?)'); }
step(true, `AES-256 key unwrapped with RSA-OAEP-3072 private key`);

let plain;
try {
  const d = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  plain = Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]);
} catch { step(false, 'AES-GCM tag check failed: ciphertext was modified'); }
step(true, 'Decrypted with AES-256-GCM (tag verified)');
step(crypto.createHash('sha256').update(plain).digest('hex') === env.plainSha256, 'SHA-256 of restored data matches');

const data = JSON.parse(plain);
const linked = data.readings.every((r, i) => i === 0 ? r.prev_hash === 'GENESIS' : r.prev_hash === data.readings[i - 1].hash);
step(linked, `Hash chain links intact across ${data.readings.length} readings`);

const out = path.join(ROOT, 'restored', path.basename(file));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(data, null, 2), { mode: 0o600 });
const last = data.readings[data.readings.length - 1];
console.log(`\nRestored ${data.readings.length} readings (backup made ${data.createdAt}).`);
if (last) console.log(`Newest: ${new Date(last.ts).toLocaleString()}  moisture ${last.moisture}%  pump ${last.pump_on ? 'on' : 'off'}`);
console.log(`Written to ${path.relative(ROOT, out)}`);
