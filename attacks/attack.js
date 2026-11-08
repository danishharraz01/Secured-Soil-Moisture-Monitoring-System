'use strict';
// Red-team script for the viva/demo. Runs common attacks against the running server
// and shows that each one is blocked or detected.
// Usage: npm run attack                (all attacks except DB tampering)
//        npm run attack -- --tamper-db (also edits the database directly, then checks integrity)
// Needs the default outbox/ email mode (no SMTP) so it can read OTP codes.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { request, signedTelemetry } = require('../shared/lib');

const root = path.join(__dirname, '..');
const device = JSON.parse(fs.readFileSync(path.join(root, 'device', 'device.json'), 'utf8'));
const ca = fs.readFileSync(path.join(root, 'certs', 'server.crt'));
const creds = fs.readFileSync(path.join(root, 'CREDENTIALS.txt'), 'utf8');
const pw = (u) => creds.match(new RegExp(`^${u}\\s+/\\s+(\\S+)`, 'm'))[1];
const emailOf = (u) => creds.match(new RegExp(`^${u}\\s+/.*?OTP -> (\\S+?)(,|\\s|$)`, 'm'))[1];
const URL_ = device.serverUrl;
const T = URL_ + '/api/device/telemetry';
const reading = (m, extra = {}) => ({ type: 'reading', moisture: m, pumpOn: false, waterMl: 0, simTime: Date.now(), ...extra });

let pass = 0, fail = 0;
function report(name, res, expect, check = () => true) {
  const ok = expect.includes(res.status) && check(res);
  ok ? pass++ : fail++;
  let msg = res.body;
  try { msg = JSON.parse(res.body).error || res.body; } catch {}
  console.log(`${ok ? 'BLOCKED ' : 'NOT BLOCKED!'}  ${name}\n            -> ${res.status} ${String(msg).slice(0, 90)}\n`);
}
const post = (url, headers, body) => request(url, { method: 'POST', headers, body, ca });
const J = { 'Content-Type': 'application/json', 'X-Requested-With': 'dashboard' };

// Read the newest OTP email for this address from outbox/
function latestCode(email, after) {
  const dir = path.join(root, 'outbox');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('email-') && Number(f.slice(6, -4)) >= after).sort().reverse();
  for (const f of files) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    if (t.includes(`To: ${email}`)) return /login code is (\d{6})/.exec(t)[1];
  }
  throw new Error('OTP email not found in outbox/');
}

async function fullLogin(u) {
  const t0 = Date.now() - 5;
  const s1 = JSON.parse((await post(URL_ + '/api/login', J, JSON.stringify({ username: u, password: pw(u) }))).body);
  const code = latestCode(emailOf(u), t0);
  const r = await post(URL_ + '/api/login/otp', J, JSON.stringify({ challengeId: s1.challengeId, code }));
  return { cookie: (r.headers['set-cookie'] || [''])[0].split(';')[0], challengeId: s1.challengeId, code };
}

(async () => {
  console.log('=== Attacks on the device channel ===\n');

  report('Fake reading with no signature',
    await post(T, { 'Content-Type': 'application/json', 'X-Device-Id': device.deviceId }, JSON.stringify(reading(5))), [401]);

  const wrong = signedTelemetry({ ...device, secret: crypto.randomBytes(32).toString('hex') }, reading(5));
  report('Fake reading signed with a wrong key', await post(T, wrong.headers, wrong.body), [401]);

  // Eavesdropper (e.g. on the Wi-Fi, or if TLS were broken) captures a real request
  const sniffed = signedTelemetry(device, reading(72));
  const readable = /moisture|72/.test(sniffed.body);
  readable ? fail++ : pass++;
  console.log(`${readable ? 'NOT BLOCKED!' : 'BLOCKED '}  Eavesdropper reads a captured reading\n            -> sees only ciphertext: ${sniffed.body.slice(0, 70)}...\n`);

  // Man-in-the-middle flips bytes in the encrypted payload
  const env = JSON.parse(sniffed.body);
  const ct = Buffer.from(env.ct, 'base64'); ct[0] ^= 0xff;
  report('Encrypted reading modified in transit', await post(T, sniffed.headers, JSON.stringify({ ...env, ct: ct.toString('base64') })), [401]);

  const plain = signedTelemetry(device, reading(5), { plaintext: true });
  report('Unencrypted payload (even with a valid signature)', await post(T, plain.headers, plain.body), [400]);

  const captured = signedTelemetry(device, reading(71));
  await post(T, captured.headers, captured.body); // the original, legit send
  report('Replay of a captured valid request', await post(T, captured.headers, captured.body), [409]);

  const old = signedTelemetry(device, reading(5), { ts: Date.now() - 5 * 60_000 });
  report('Request captured 5 minutes ago', await post(T, old.headers, old.body), [401]);

  report('SQL injection in device ID', await post(T, { 'X-Device-Id': "x' OR '1'='1" }, '{}'), [401]);

  const bad = signedTelemetry(device, reading(450));
  report('Out-of-range value (moisture 450%)', await post(T, bad.headers, bad.body), [400]);

  const fakeMotion = signedTelemetry({ ...device, secret: crypto.randomBytes(32).toString('hex') }, { type: 'motion', sensor: 'pir-1', simTime: Date.now() });
  report('Fake motion alert to spam the owner with SMS', await post(T, fakeMotion.headers, fakeMotion.body), [401]);

  const big = signedTelemetry(device, reading(50, { junk: 'A'.repeat(5000) }));
  report('Oversized payload (5 KB)', await post(T, big.headers, big.body).catch(() => ({ status: 413, body: 'connection closed' })), [413]);

  console.log('=== Attacks on the app / dashboard ===\n');

  report('Read readings without logging in', await request(URL_ + '/api/readings', { ca }), [401]);

  const viewer = await fullLogin('viewer');
  const admin = await fullLogin('admin');

  report('Reuse an OTP code that was already used',
    await post(URL_ + '/api/login/otp', J, JSON.stringify({ challengeId: admin.challengeId, code: admin.code })), [401]);

  const asViewer = { Cookie: viewer.cookie, ...J };
  report('Viewer tries to set thresholds to 10-15% (kill the plant)',
    await request(URL_ + '/api/config', { method: 'PUT', ca, headers: asViewer, body: JSON.stringify({ deviceId: device.deviceId, low: 10, high: 15 }) }), [403]);
  report('Viewer tries to download a backup', await post(URL_ + '/api/backup', asViewer, '{}'), [403]);

  report('CSRF request without the dashboard header',
    await request(URL_ + '/api/config', { method: 'PUT', ca, headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: device.deviceId, low: 10, high: 15 }) }), [403]);

  // Attacker knows the admin password (phished / leaked) but not the email OTP
  const s1 = JSON.parse((await post(URL_ + '/api/login', J, JSON.stringify({ username: 'admin', password: pw('admin') }))).body);
  let last;
  for (let i = 0; i < 5; i++) last = await post(URL_ + '/api/login/otp', J, JSON.stringify({ challengeId: s1.challengeId, code: String(100000 + i) }));
  report('Stolen password, guessing the email OTP (5 guesses)', last, [401], (r) => JSON.parse(r.body).restart === true);

  // Brute-force login (run last: it locks this IP out for 5 minutes)
  for (let i = 0; i < 3; i++) last = await post(URL_ + '/api/login', J, JSON.stringify({ username: 'admin', password: 'password' + i }));
  report('Brute-force admin password', last, [429]);

  if (process.argv.includes('--tamper-db')) {
    console.log('=== Insider / stolen DB: edit a stored reading directly ===\n');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(root, 'data', 'soil.db'));
    const row = db.prepare('SELECT id, moisture FROM readings ORDER BY id LIMIT 1 OFFSET 3').get();
    db.prepare('UPDATE readings SET moisture = 99 WHERE id = ?').run(row.id);
    db.close();
    console.log(`Changed reading #${row.id} from ${row.moisture}% to 99% in the database file.`);
    const check = JSON.parse((await request(URL_ + '/api/verify', { ca, headers: { Cookie: admin.cookie } })).body);
    const detected = check.ok === false;
    detected ? pass++ : fail++;
    console.log(`${detected ? 'DETECTED' : 'NOT DETECTED!'}  integrity check -> ${JSON.stringify(check)}\n`);
    console.log('Note: the chain stays broken from now on (that is the point). Run `npm run reset` for a clean database.\n');
  }

  console.log(`Result: ${pass} blocked/detected, ${fail} got through.`);
  process.exit(fail ? 1 : 0);
})();
