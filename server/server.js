'use strict';
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { open } = require('./db');
const S = require('./secrets');
const syslog = require('./syslog');
const { sendEmail, sendSms } = require('./notify');
const { createBackup } = require('./backup');
const { hmac, safeEqualHex, signingString, deviceKeys, decryptPayload } = require('../shared/lib');

if (!S.secrets) {
  console.error('Run `npm run setup` first.');
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8443);
const MAX_CLOCK_SKEW_MS = 30_000;                                   // signed device requests older than this are rejected
const NONCE_TTL_MS = 10 * 60_000;
const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_MS || 10 * 60_000); // "log out after 10 minutes"
const SESSION_MAX_MS = 8 * 3600_000;                               // hard limit even if active
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 5 * 60_000;
const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const MOTION_SMS_COOLDOWN_MS = 2 * 60_000;
const BACKUP_EVERY_MS = Number(process.env.BACKUP_EVERY_MS || 10 * 60_000);

const db = open();
const signKey = crypto.createPrivateKey(S.secrets.serverSignPrivPem);

const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

// ---------- small helpers ----------
function send(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS, ...extra });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c); // past the limit we just drain and discard
    });
    req.on('end', () => {
      if (size > limit) reject(Object.assign(new Error('Payload too large'), { status: 413 }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const ipOf = (req) => req.socket.remoteAddress || '?';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const WARN = /rejected|failed|blocked|forbidden|anomaly|otp_wrong|otp_locked|session_idle/;

// Every security event goes to the database AND to the central syslog server.
function audit(actor, action, detail, ip) {
  db.prepare('INSERT INTO audit (at, actor, action, detail, ip) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), actor, action, JSON.stringify(detail ?? null), ip ?? null);
  const tamper = action === 'integrity_check' && detail && detail.ok === false;
  syslog.log({
    facility: 'auth',
    severity: tamper ? 'crit' : WARN.test(action) ? 'warning' : 'notice',
    msgId: action,
    data: { actor, ip: ip ?? '-' },
    message: detail ? JSON.stringify(detail) : action,
  });
}

function addAlert(type, level, message, simTime) {
  db.prepare('INSERT INTO alerts (at, sim_time, type, level, message) VALUES (?, ?, ?, ?, ?)').run(Date.now(), simTime ?? null, type, level, message);
}

// ---------- tamper-evident storage ----------
function insertReading(r) {
  const prev = db.prepare('SELECT hash FROM readings ORDER BY id DESC LIMIT 1').get();
  const prevHash = prev ? prev.hash : 'GENESIS';
  const fields = [r.device_id, r.ts, r.moisture, r.pump_on, r.water_ml, r.received_at];
  const hash = S.chainHash(prevHash, fields);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO readings (device_id, ts, moisture, pump_on, water_ml, received_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(...fields, prevHash, hash);
  // Signed pointer to the newest row, so deleting rows from the end is also caught.
  const id = Number(lastInsertRowid);
  db.prepare('INSERT INTO meta (key, value) VALUES (\'head\', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(JSON.stringify({ id, hash, mac: S.headMac(id, hash) }));
}

function verifyChain() {
  const rows = db.prepare('SELECT * FROM readings ORDER BY id').all();
  let prev = 'GENESIS';
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, checked: rows.length, brokenAt: r.id, reason: 'Chain link broken: a record before this one was deleted or replaced' };
    const h = S.chainHash(prev, [r.device_id, r.ts, r.moisture, r.pump_on, r.water_ml, r.received_at]);
    if (h !== r.hash) return { ok: false, checked: rows.length, brokenAt: r.id, reason: 'Record content was modified after it was stored' };
    prev = r.hash;
  }
  const headRow = db.prepare('SELECT value FROM meta WHERE key = \'head\'').get();
  if (rows.length || headRow) {
    const head = headRow && parseJson(headRow.value);
    const last = rows[rows.length - 1];
    if (!head || head.mac !== S.headMac(head.id, head.hash)) return { ok: false, checked: rows.length, reason: 'Chain head pointer was tampered with' };
    if (!last || head.id !== last.id || head.hash !== last.hash) return { ok: false, checked: rows.length, reason: 'Newest records were deleted (chain is shorter than the signed head)' };
  }
  return { ok: true, checked: rows.length };
}

let tamperAlerted = false;
function runIntegrityCheck(actor, ip) {
  const result = verifyChain();
  audit(actor, 'integrity_check', result, ip);
  if (!result.ok && !tamperAlerted) {
    tamperAlerted = true;
    addAlert('tamper', 'critical', `Stored data was tampered with${result.brokenAt ? ` (reading #${result.brokenAt})` : ''}`);
  }
  return result;
}

// ---------- device API ----------
let lastMotionSms = 0;

async function handleTelemetry(req, res) {
  const ip = ipOf(req);
  const deviceId = req.headers['x-device-id'];
  const ts = Number(req.headers['x-timestamp']);
  const nonce = req.headers['x-nonce'];
  const sig = req.headers['x-signature'];
  const raw = await readBody(req, 2048);

  const reject = (status, reason) => {
    audit(`device:${String(deviceId).slice(0, 40)}`, 'telemetry_rejected', { reason }, ip);
    send(res, status, { error: reason });
  };

  if (typeof deviceId !== 'string' || !/^[a-z0-9-]{3,40}$/.test(deviceId)) return reject(401, 'Unknown device');
  const dev = db.prepare('SELECT * FROM devices WHERE id = ? AND enabled = 1').get(deviceId);
  if (!dev) return reject(401, 'Unknown device');
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) return reject(401, 'Timestamp missing or too old');
  if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) return reject(401, 'Invalid nonce');

  const keys = deviceKeys(S.decrypt(dev.secret_enc));
  const expected = hmac(keys.macKey, signingString('POST', '/api/device/telemetry', ts, nonce, raw));
  if (!safeEqualHex(sig, expected)) return reject(401, 'Bad signature');

  // Replay protection: each nonce is accepted once.
  db.prepare('DELETE FROM nonces WHERE seen_at < ?').run(Date.now() - NONCE_TTL_MS);
  try {
    db.prepare('INSERT INTO nonces (device_id, nonce, seen_at) VALUES (?, ?, ?)').run(deviceId, nonce, Date.now());
  } catch {
    return reject(409, 'Replay detected: this request was already used');
  }

  // The payload must be AES-128-GCM encrypted. Plain JSON is refused even with a valid signature.
  const env = parseJson(raw);
  if (!env || env.alg !== 'AES-128-GCM' || typeof env.iv !== 'string' || typeof env.ct !== 'string' || typeof env.tag !== 'string') {
    return reject(400, 'Payload must be encrypted');
  }
  let b;
  try { b = decryptPayload(keys.encKey, env, deviceId); } catch { return reject(400, 'Cannot decrypt payload'); }

  if (b && b.type === 'motion') {
    if (!Number.isInteger(b.simTime) || typeof b.sensor !== 'string' || !/^[a-z0-9-]{1,20}$/.test(b.sensor)) return reject(400, 'Invalid payload');
    const when = new Date(b.simTime).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' });
    addAlert('motion', 'warning', `PIR sensor saw movement near the celery plant at ${when}. SMS sent to owner.`, b.simTime);
    syslog.log({ facility: 'auth', severity: 'warning', msgId: 'motion_detected', data: { device: deviceId, sensor: b.sensor }, message: 'PIR sensor detected movement near the plant' });
    db.prepare('INSERT INTO audit (at, actor, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(Date.now(), `device:${deviceId}`, 'motion_detected', JSON.stringify({ sensor: b.sensor }), ip);
    if (Date.now() - lastMotionSms > MOTION_SMS_COOLDOWN_MS) {
      lastMotionSms = Date.now();
      for (const a of db.prepare("SELECT phone FROM users WHERE role = 'admin' AND phone IS NOT NULL").all()) {
        sendSms(a.phone, `[Celery Monitor] Motion detected near your celery plant at ${when}. Check the app.`).catch(() => {});
      }
    }
  } else {
    const valid = b && b.type === 'reading'
      && typeof b.moisture === 'number' && b.moisture >= 0 && b.moisture <= 100
      && typeof b.pumpOn === 'boolean'
      && typeof b.waterMl === 'number' && b.waterMl >= 0 && b.waterMl <= 2000
      && Number.isInteger(b.simTime);
    if (!valid) return reject(400, 'Invalid payload');

    const last = db.prepare('SELECT moisture, pump_on FROM readings WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(deviceId);
    // Plausibility check: real soil doesn't jump 15% in one reading. Flag it for review.
    if (last && Math.abs(last.moisture - b.moisture) > 15) audit(`device:${deviceId}`, 'anomaly', { from: last.moisture, to: b.moisture }, ip);
    // "Relay module activates sprinkler -> send notification to user"
    if (b.pumpOn && (!last || !last.pump_on)) {
      addAlert('sprinkler_on', 'info', `Soil dropped to ${(Math.floor(b.moisture * 10) / 10).toFixed(1)}% (below ${dev.low}%), relay switched the sprinkler on`, b.simTime);
    }

    insertReading({
      device_id: deviceId, ts: b.simTime, moisture: Math.round(b.moisture * 100) / 100,
      pump_on: b.pumpOn ? 1 : 0, water_ml: Math.round(b.waterMl), received_at: Date.now(),
    });
    syslog.log({
      facility: 'sensor', severity: 'info', msgId: 'reading',
      data: { device: deviceId, moisture: b.moisture.toFixed(1), pump: b.pumpOn ? 'on' : 'off' },
      message: `moisture=${b.moisture.toFixed(1)}% pump=${b.pumpOn ? 'on' : 'off'}`,
    });
  }

  // Reply with the current thresholds, signed with the server's private key.
  // Echoing the nonce ties this reply to this request, so old replies can't be replayed to the device.
  const payload = JSON.stringify({ deviceId, low: dev.low, high: dev.high, nonce, issuedAt: Date.now() });
  const serverSig = crypto.sign(null, Buffer.from(payload), signKey).toString('base64');
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Server-Signature': serverSig, ...SEC_HEADERS });
  res.end(payload);
}

// ---------- user auth: password -> email OTP -> session ----------
const loginFails = new Map(); // ip -> { count, resetAt }
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

function cookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : null;
}

// Browsers use the cookie; the mobile app sends "Authorization: Bearer <token>".
function bearer(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

function sessionToken(req) {
  return bearer(req) || cookie(req, 'sid');
}

// Returns { user } or { reason }. Background polling (X-Activity: poll) doesn't count as
// activity, so leaving the app open untouched still logs you out after 10 minutes.
function currentUser(req) {
  const token = sessionToken(req);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return { reason: 'Please log in' };
  const th = sha256(token);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(th);
  const now = Date.now();
  if (!s) return { reason: 'Please log in' };
  if (s.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th);
    return { reason: 'Session expired. Please log in again.' };
  }
  if (now - s.last_seen > SESSION_IDLE_MS) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th);
    audit(s.username, 'session_idle_logout', { idleMinutes: Math.round((now - s.last_seen) / 60000) }, ipOf(req));
    return { reason: `Logged out after ${SESSION_IDLE_MS >= 60000 ? `${Math.round(SESSION_IDLE_MS / 60000)} minutes` : `${SESSION_IDLE_MS / 1000} seconds`} of inactivity.` };
  }
  if (req.headers['x-activity'] !== 'poll') db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, th);
  const user = db.prepare('SELECT username, role FROM users WHERE username = ?').get(s.username);
  return user ? { user } : { reason: 'Please log in' };
}

function tooManyFails(ip, res) {
  const rec = loginFails.get(ip);
  if (rec && rec.resetAt > Date.now() && rec.count >= LOGIN_MAX_FAILS) {
    audit('anonymous', 'login_blocked', { reason: 'too many attempts' }, ip);
    send(res, 429, { error: 'Too many failed attempts. Try again in a few minutes.' });
    return true;
  }
  return false;
}

function countFail(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip);
  const r = rec && rec.resetAt > now ? rec : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  r.count++;
  loginFails.set(ip, r);
}

const otpHash = (id, code) => hmac(S.secrets.masterKey, `otp|${id}|${code}`);
const maskEmail = (e) => e.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.min(b.length, 6)) + c);

// Step 1: username + password. If correct, email a 6-digit code.
async function handleLogin(req, res) {
  const ip = ipOf(req);
  if (tooManyFails(ip, res)) return;
  const b = parseJson(await readBody(req, 1024)) || {};
  const username = typeof b.username === 'string' ? b.username.slice(0, 50) : '';
  const password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  // Always run scrypt, even for unknown users, so response time doesn't reveal valid usernames.
  const attempt = crypto.scryptSync(password, user ? user.salt : DUMMY_SALT, 64);
  const ok = user && crypto.timingSafeEqual(attempt, Buffer.from(user.pass_hash, 'hex'));
  if (!ok) {
    countFail(ip);
    audit(username || 'anonymous', 'login_failed', null, ip);
    return send(res, 401, { error: 'Wrong username or password' });
  }

  const id = crypto.randomBytes(16).toString('hex');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const client = req.headers['x-client'] === 'mobile' ? 'mobile' : 'web';
  db.prepare('DELETE FROM otp_challenges WHERE expires_at < ? OR used = 1').run(Date.now());
  db.prepare('INSERT INTO otp_challenges (id, username, code_hash, client, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, user.username, otpHash(id, code), client, Date.now() + OTP_TTL_MS);
  await sendEmail(user.email, 'Your Celery Soil Monitor login code',
    `Your login code is ${code}\n\nIt expires in 5 minutes and works once.\nIf you didn't try to log in, change your password.`);
  audit(user.username, 'otp_sent', { client, to: maskEmail(user.email) }, ip);
  send(res, 200, { otpRequired: true, challengeId: id, sentTo: maskEmail(user.email), expiresIn: OTP_TTL_MS / 1000 });
}

// Step 2: the code from the email. Wrong 5 times -> challenge is dead, start again ("No" branch).
async function handleOtp(req, res) {
  const ip = ipOf(req);
  if (tooManyFails(ip, res)) return;
  const b = parseJson(await readBody(req, 1024)) || {};
  const id = typeof b.challengeId === 'string' && /^[a-f0-9]{32}$/.test(b.challengeId) ? b.challengeId : '';
  const code = typeof b.code === 'string' ? b.code.trim() : '';
  const ch = id && db.prepare('SELECT * FROM otp_challenges WHERE id = ?').get(id);

  if (!ch || ch.used || ch.expires_at < Date.now()) {
    audit(ch ? ch.username : 'anonymous', 'otp_rejected', { reason: !ch ? 'unknown' : ch.used ? 'already used' : 'expired' }, ip);
    return send(res, 401, { error: 'Code expired or already used. Please log in again.', restart: true });
  }
  if (ch.attempts >= OTP_MAX_ATTEMPTS) {
    return send(res, 401, { error: 'Too many wrong codes. Please log in again.', restart: true });
  }
  db.prepare('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?').run(id);

  if (!/^\d{6}$/.test(code) || !safeEqualHex(otpHash(id, code), ch.code_hash)) {
    countFail(ip);
    const left = OTP_MAX_ATTEMPTS - ch.attempts - 1;
    audit(ch.username, left > 0 ? 'otp_wrong' : 'otp_locked', { attemptsLeft: left }, ip);
    if (left <= 0) db.prepare('UPDATE otp_challenges SET used = 1 WHERE id = ?').run(id);
    return send(res, 401, left > 0
      ? { error: `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` }
      : { error: 'Too many wrong codes. Please log in again.', restart: true });
  }

  db.prepare('UPDATE otp_challenges SET used = 1 WHERE id = ?').run(id);
  loginFails.delete(ip);
  const user = db.prepare('SELECT username, role FROM users WHERE username = ?').get(ch.username);
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO sessions (token_hash, username, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), user.username, now, now, now + SESSION_MAX_MS);
  audit(user.username, ch.client === 'mobile' ? 'login_mobile' : 'login', { mfa: 'email-otp' }, ip);

  const body = { username: user.username, role: user.role, idleTimeout: SESSION_IDLE_MS / 1000 };
  // The app gets the token once and keeps it in the phone's secure storage (Keychain / Keystore).
  if (ch.client === 'mobile') return send(res, 200, { ...body, token });
  send(res, 200, body, { 'Set-Cookie': `sid=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_MS / 1000}` });
}

// ---------- router ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

async function route(req, res) {
  const url = new URL(req.url, 'https://localhost');
  const p = url.pathname;
  const ip = ipOf(req);

  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    res.writeHead(200, { 'Content-Type': type, ...SEC_HEADERS });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
  }

  if (req.method === 'POST' && p === '/api/device/telemetry') return handleTelemetry(req, res);

  if (!p.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

  // Everything below is the user API (web dashboard + mobile app). CSRF only matters for
  // cookie logins: those state-changing calls need our custom header. Bearer-token requests
  // (the app) are immune, because a browser never attaches that header on its own.
  const csrfOk = bearer(req) || req.headers['x-requested-with'] === 'dashboard' || req.headers['x-client'] === 'mobile';
  if (req.method !== 'GET' && !csrfOk) {
    return send(res, 403, { error: 'Missing CSRF header' });
  }

  if (req.method === 'POST' && p === '/api/login') return handleLogin(req, res);
  if (req.method === 'POST' && p === '/api/login/otp') return handleOtp(req, res);

  const { user, reason } = currentUser(req);
  if (!user) return send(res, 401, { error: reason });

  if (req.method === 'POST' && p === '/api/logout') {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(sessionToken(req)));
    audit(user.username, 'logout', null, ip);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (req.method === 'GET' && p === '/api/me') return send(res, 200, user);

  if (req.method === 'GET' && p === '/api/readings') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 150, 1), 1000);
    const rows = db.prepare('SELECT id, device_id, ts, moisture, pump_on, water_ml FROM readings ORDER BY id DESC LIMIT ?').all(limit);
    const totals = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(water_ml), 0) AS water FROM readings').get();
    return send(res, 200, { readings: rows.reverse(), totals });
  }

  if (req.method === 'GET' && p === '/api/alerts') {
    const since = Math.max(parseInt(url.searchParams.get('since'), 10) || 0, 0);
    const rows = since
      ? db.prepare('SELECT * FROM alerts WHERE id > ? ORDER BY id LIMIT 50').all(since)
      : db.prepare('SELECT * FROM (SELECT * FROM alerts ORDER BY id DESC LIMIT 20) ORDER BY id').all();
    const lastMotion = db.prepare("SELECT at FROM alerts WHERE type = 'motion' ORDER BY id DESC LIMIT 1").get();
    return send(res, 200, { alerts: rows, lastMotionAt: lastMotion ? lastMotion.at : null });
  }

  if (req.method === 'GET' && p === '/api/config') {
    return send(res, 200, db.prepare('SELECT id, low, high FROM devices').all());
  }

  if (req.method === 'PUT' && p === '/api/config') {
    if (user.role !== 'admin') {
      audit(user.username, 'forbidden', { action: 'change thresholds' }, ip);
      return send(res, 403, { error: 'Only admin can change thresholds' });
    }
    const b = parseJson(await readBody(req, 1024)) || {};
    const { deviceId, low, high } = b;
    const ok = typeof deviceId === 'string' && Number.isFinite(low) && Number.isFinite(high)
      && low >= 10 && high <= 95 && high - low >= 5;
    if (!ok) return send(res, 400, { error: 'Thresholds must be 10-95% with at least 5% between low and high' });
    const before = db.prepare('SELECT low, high FROM devices WHERE id = ?').get(deviceId);
    if (!before) return send(res, 404, { error: 'No such device' });
    db.prepare('UPDATE devices SET low = ?, high = ? WHERE id = ?').run(low, high, deviceId);
    audit(user.username, 'thresholds_changed', { deviceId, before, after: { low, high } }, ip);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/api/verify') {
    return send(res, 200, runIntegrityCheck(user.username, ip));
  }

  if (req.method === 'POST' && p === '/api/backup') {
    if (user.role !== 'admin') {
      audit(user.username, 'forbidden', { action: 'backup' }, ip);
      return send(res, 403, { error: 'Admin only' });
    }
    const r = createBackup(db, signKey);
    audit(user.username, 'backup_created', r, ip);
    return send(res, 200, r);
  }

  if (req.method === 'GET' && p === '/api/audit') {
    if (user.role !== 'admin') return send(res, 403, { error: 'Admin only' });
    return send(res, 200, db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 50').all());
  }

  send(res, 404, { error: 'Not found' });
}

const server = https.createServer({
  key: fs.readFileSync(path.join(__dirname, '..', 'certs', 'server.key')),
  cert: fs.readFileSync(path.join(__dirname, '..', 'certs', 'server.crt')),
  minVersion: 'TLSv1.2',
}, (req, res) => {
  route(req, res).catch((err) => {
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
    if (!err.status) console.error(err);
  });
});

// Scheduled encrypted backup to the "cloud" folder.
setInterval(() => {
  try {
    const r = createBackup(db, signKey);
    audit('system', 'backup_created', r, null);
  } catch (e) { console.error('Backup failed:', e.message); }
}, BACKUP_EVERY_MS).unref();

server.listen(PORT, () => {
  console.log(`Server running at https://localhost:${PORT}`);
  const lan = Object.values(require('node:os').networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `https://${i.address}:${PORT}`);
  if (lan.length) console.log(`On your Wi-Fi (for the phone app): ${lan.join(', ')}`);
  console.log(`Sessions log out after ${SESSION_IDLE_MS / 60000} min of inactivity. Backups every ${BACKUP_EVERY_MS / 60000} min.`);
});
