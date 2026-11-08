'use strict';
// Web dashboard. All server data is written with textContent (never innerHTML) to avoid XSS.
const $ = (id) => document.getElementById(id);
let me = null;
let deviceId = null;
let timer = null;
let challengeId = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'dashboard', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/login')) { showLogin(data.error); throw new Error('logged out'); }
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}
// Background refreshes don't count as activity, so the 10-minute idle logout still works.
const poll = (path) => api(path, { headers: { 'X-Activity': 'poll' } });

function showLogin(message) {
  clearInterval(timer);
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-form').hidden = false;
  $('otp-form').hidden = true;
  $('login-error').textContent = message && message !== 'Please log in' ? message : '';
}

async function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  $('who').textContent = `${me.username} (${me.role})`;
  const isAdmin = me.role === 'admin';
  $('save-config').disabled = !isAdmin;
  $('backup').disabled = !isAdmin;
  if (!isAdmin) $('config-msg').textContent = 'Read-only: only admin can change thresholds.';
  $('audit-card').hidden = !isAdmin;
  const cfg = await api('/api/config');
  if (cfg[0]) {
    deviceId = cfg[0].id;
    $('config-form').low.value = cfg[0].low;
    $('config-form').high.value = cfg[0].high;
  }
  refresh();
  timer = setInterval(refresh, 2000);
}

async function refresh() {
  const [{ readings, totals }, cfg, al] = await Promise.all([poll('/api/readings?limit=150'), poll('/api/config'), poll('/api/alerts')]);
  const last = readings[readings.length - 1];
  if (last) {
    $('moisture').textContent = last.moisture.toFixed(1) + '%';
    $('pump').textContent = last.pump_on ? 'Watering' : 'Off';
    $('simtime').textContent = new Date(last.ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  $('water').textContent = (totals.water / 1000).toFixed(2) + ' L';
  const recentMotion = al.lastMotionAt && Date.now() - al.lastMotionAt < 60_000;
  $('led').className = 'led' + (recentMotion ? ' on' : '');
  $('motion-text').textContent = recentMotion ? 'Motion!' : 'Clear';
  $('alerts').replaceChildren(...al.alerts.slice().reverse().slice(0, 5).map((a) => {
    const li = document.createElement('li');
    li.className = a.level;
    const t = document.createElement('small'); t.textContent = new Date(a.at).toLocaleTimeString();
    const m = document.createElement('span'); m.textContent = a.message;
    li.append(m, t);
    return li;
  }));
  drawChart(readings, cfg[0] || { low: 60, high: 80 });
  if (me.role === 'admin') loadAudit();
}

function drawChart(rows, { low, high }) {
  const c = $('chart');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height, padL = 36, padB = 20, padT = 10;
  ctx.clearRect(0, 0, W, H);
  const x = (i) => padL + (i / Math.max(rows.length - 1, 1)) * (W - padL - 8);
  const y = (v) => padT + (1 - v / 100) * (H - padT - padB);

  ctx.font = '11px system-ui'; ctx.fillStyle = '#6b7566'; ctx.strokeStyle = '#eef0eb';
  for (let v = 0; v <= 100; v += 20) {
    ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(W, y(v)); ctx.stroke();
    ctx.fillText(v + '%', 4, y(v) + 4);
  }
  ctx.fillStyle = 'rgba(63,125,58,0.13)';
  const bw = (W - padL) / Math.max(rows.length, 1);
  rows.forEach((r, i) => { if (r.pump_on) ctx.fillRect(x(i) - bw / 2, padT, bw, H - padT - padB); });

  ctx.setLineDash([5, 4]); ctx.strokeStyle = '#9aa594';
  for (const v of [low, high]) { ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(W, y(v)); ctx.stroke(); }
  ctx.setLineDash([]);

  ctx.strokeStyle = '#2f6db3'; ctx.lineWidth = 2; ctx.beginPath();
  rows.forEach((r, i) => (i ? ctx.lineTo(x(i), y(r.moisture)) : ctx.moveTo(x(i), y(r.moisture))));
  ctx.stroke(); ctx.lineWidth = 1;
}

async function loadAudit() {
  const rows = await poll('/api/audit');
  $('audit').replaceChildren(...rows.map((a) => {
    const tr = document.createElement('tr');
    [new Date(a.at).toLocaleTimeString(), a.actor, a.action, a.detail === 'null' ? '' : a.detail, a.ip].forEach((v) => {
      const td = document.createElement('td'); td.textContent = v ?? ''; tr.appendChild(td);
    });
    if (/rejected|failed|blocked|forbidden|anomaly|otp_wrong|otp_locked|motion|idle/.test(a.action)) tr.className = 'bad';
    return tr;
  }));
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const f = e.target;
  try {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: f.username.value, password: f.password.value }) });
    f.password.value = '';
    challengeId = r.challengeId;
    $('otp-sent').textContent = `We sent a 6-digit code to ${r.sentTo}. It expires in 5 minutes.`;
    $('login-form').hidden = true;
    $('otp-form').hidden = false;
    $('otp-form').code.focus();
  } catch (err) { $('login-error').textContent = err.message; }
});

$('otp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('otp-error').textContent = '';
  const f = e.target;
  try {
    me = await api('/api/login/otp', { method: 'POST', body: JSON.stringify({ challengeId, code: f.code.value }) });
    f.code.value = '';
    showApp();
  } catch (err) {
    f.code.value = '';
    if (err.data && err.data.restart) showLogin(err.message); // "Correct OTP? No" -> back to login
    else $('otp-error').textContent = err.message;
  }
});

$('otp-back').addEventListener('click', () => showLogin());
$('logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

$('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ deviceId, low: Number(f.low.value), high: Number(f.high.value) }) });
    $('config-msg').textContent = 'Saved. The device picks this up on its next report.';
  } catch (err) { $('config-msg').textContent = err.message; }
});

$('verify').addEventListener('click', async () => {
  const r = await api('/api/verify');
  const el = $('verify-result');
  el.className = r.ok ? 'good' : 'bad';
  el.textContent = r.ok
    ? `OK: all ${r.checked} readings are intact.`
    : `TAMPERING DETECTED${r.brokenAt ? ` at reading #${r.brokenAt}` : ''}: ${r.reason}`;
});

$('backup').addEventListener('click', async () => {
  try {
    const r = await api('/api/backup', { method: 'POST' });
    $('backup-result').textContent = `Saved ${r.records} readings to ${r.file} (encrypted).`;
  } catch (err) { $('backup-result').textContent = err.message; }
});

api('/api/me').then((u) => { me = u; showApp(); }).catch(() => showLogin());
