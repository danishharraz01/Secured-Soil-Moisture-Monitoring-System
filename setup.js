'use strict';
// One-time setup: creates keys, TLS certificate, the database, one device and two users.
// Run again with --reset to wipe everything and start fresh.
// Optional: ADMIN_EMAIL, VIEWER_EMAIL, ADMIN_PHONE set where OTP emails and SMS alerts go.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = __dirname;
const p = (...x) => path.join(root, ...x);

if (process.argv.includes('--reset')) {
  for (const f of ['data', 'certs', 'server/secrets.json', 'server/backup-public.pem', 'server/server-public.pem',
    'offline-keys', 'cloud', 'restored', 'outbox', 'logs', 'device/device.json', 'CREDENTIALS.txt']) {
    fs.rmSync(p(f), { recursive: true, force: true });
  }
}
if (fs.existsSync(p('server/secrets.json'))) {
  console.log('Already set up. Use `npm run reset` to start over.');
  process.exit(0);
}

// 1. Server secrets + Ed25519 key pair (server signs commands sent back to the device)
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(p('server/secrets.json'), JSON.stringify({
  masterKey: crypto.randomBytes(32).toString('hex'),
  chainKey: crypto.randomBytes(32).toString('hex'),
  serverSignPrivPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
}, null, 2), { mode: 0o600 });
fs.writeFileSync(p('server/server-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));

// 1b. Backup key pair (RSA-3072). The server only gets the PUBLIC key. The private key goes to
// offline-keys/ - in real life you'd move it to a USB drive or password manager, not the server.
const backup = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
fs.writeFileSync(p('server/backup-public.pem'), backup.publicKey.export({ type: 'spki', format: 'pem' }));
fs.mkdirSync(p('offline-keys'), { recursive: true, mode: 0o700 });
fs.writeFileSync(p('offline-keys/backup-private.pem'), backup.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

// 2. Self-signed TLS certificate for localhost + this computer's Wi-Fi/LAN addresses
// (so the phone app can reach the server on the same network)
fs.mkdirSync(p('certs'), { recursive: true });
const lanIps = Object.values(require('node:os').networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanIps.map((ip) => `IP:${ip}`)].join(',');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
  '-keyout', p('certs/server.key'), '-out', p('certs/server.crt'), '-days', '365',
  '-subj', '/CN=localhost', '-addext', `subjectAltName=${san}`,
], { stdio: 'ignore' });
// Public-key pin (SPKI SHA-256) for certificate pinning in the mobile app's production build
const spkiPin = crypto.createHash('sha256')
  .update(crypto.createPublicKey(fs.readFileSync(p('certs/server.crt'))).export({ type: 'spki', format: 'der' }))
  .digest('base64');
fs.writeFileSync(p('certs/spki-pin.txt'), spkiPin + '\n');

// 3. Database: device + users
const S = require('./server/secrets');
const db = require('./server/db').open();

const deviceId = 'celery-node-01';
const deviceSecret = crypto.randomBytes(32).toString('hex');
// Celery likes soil that stays evenly moist. Pump on at <= 24.5 mm, off at 32 mm (FYP proposal);
// these are starting values, tune them in the dashboard.
const { MOISTURE } = require('./shared/lib');
db.prepare('INSERT INTO devices (id, secret_enc, low, high) VALUES (?, ?, ?, ?)')
  .run(deviceId, S.encrypt(deviceSecret), MOISTURE.defaultLow, MOISTURE.defaultHigh);

function addUser(username, role, email, phone) {
  const password = crypto.randomBytes(9).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  db.prepare('INSERT INTO users (username, salt, pass_hash, role, email, phone) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, salt, hash, role, email, phone ?? null);
  return password;
}
const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
const viewerEmail = process.env.VIEWER_EMAIL || 'viewer@example.com';
const adminPhone = process.env.ADMIN_PHONE || '+60123456789';
const adminPw = addUser('admin', 'admin', adminEmail, adminPhone);
const viewerPw = addUser('viewer', 'viewer', viewerEmail);

// 4. What gets "flashed" onto the device: its ID, its key, the server's public key and the pinned cert
fs.writeFileSync(p('device/device.json'), JSON.stringify({
  deviceId,
  secret: deviceSecret,
  serverUrl: 'https://localhost:8443',
  serverPubPem: publicKey.export({ type: 'spki', format: 'pem' }),
}, null, 2), { mode: 0o600 });

const creds = `Dashboard: https://localhost:8443
Phone app server URL: ${lanIps.length ? lanIps.map((ip) => `https://${ip}:8443`).join(' or ') : '(no Wi-Fi address found)'}
admin  / ${adminPw}   (can change watering thresholds, see audit log)  OTP -> ${adminEmail}, SMS -> ${adminPhone}
viewer / ${viewerPw}   (read-only)  OTP -> ${viewerEmail}
Login needs password + 6-digit code from email. Without SMTP settings, emails land in outbox/.
Certificate pin (SPKI SHA-256): ${spkiPin}
`;
fs.writeFileSync(p('CREDENTIALS.txt'), creds, { mode: 0o600 });
console.log('Setup done.\n\n' + creds + '\nSaved to CREDENTIALS.txt');
