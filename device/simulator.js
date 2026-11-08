'use strict';
// Virtual IoT node: soil moisture sensor + relay/sprinkler + PIR motion sensor + LED.
// It replaces the hardware (Arduino/ESP32 + sensors) with a small physics model, but talks
// to the server exactly like real firmware would: encrypted (AES-128-GCM), signed (HMAC-SHA256),
// over HTTPS with a pinned certificate.
//
// 1 real second = 10 minutes of garden time, so a full day passes in about 2.5 minutes.
// Press "m" then Enter in this terminal to trigger the motion sensor yourself.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { request, signedTelemetry } = require('../shared/lib');

const cfgPath = path.join(__dirname, 'device.json');
if (!fs.existsSync(cfgPath)) { console.error('Run `npm run setup` first.'); process.exit(1); }
const device = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const ca = fs.readFileSync(path.join(__dirname, '..', 'certs', 'server.crt')); // pinned cert
const serverPub = crypto.createPublicKey(device.serverPubPem);

const TICK_MS = Number(process.env.TICK_MS || 1000);
const SIM_MINUTES_PER_TICK = 10;
const MOTION_CHANCE = Number(process.env.MOTION_CHANCE ?? 0.004); // random visitor (cat, bird, person)
const LED_TICKS = 3;

// ---- virtual garden ----
const state = {
  moisture: 70,            // % volumetric water content (what the sensor reports)
  pumpOn: false,
  simTime: Date.now(),
  thresholds: { low: 60, high: 80 }, // safe defaults until the server sends signed ones
  ledTicks: 0,             // red LED stays on for a few ticks after motion
  motionPending: false,
};

function stepPhysics() {
  state.simTime += SIM_MINUTES_PER_TICK * 60_000;
  const hour = new Date(state.simTime).getHours();
  const daytime = hour >= 9 && hour < 18;
  // Celery is thirsty and the afternoon sun dries the pot faster.
  const evaporation = (daytime ? 0.9 : 0.35) + Math.random() * 0.3;
  state.moisture -= evaporation;
  let waterMl = 0;
  if (state.pumpOn) {
    waterMl = 120;                 // sprinkler runs for this tick
    state.moisture += 3.2;
  }
  state.moisture = Math.min(100, Math.max(0, state.moisture));
  return waterMl;
}

// Edge control loop with hysteresis, so the relay doesn't flicker on and off.
// It runs on the device, so the plant still gets water if the network is down.
function control() {
  const { low, high } = state.thresholds;
  if (!state.pumpOn && state.moisture < low) state.pumpOn = true;
  else if (state.pumpOn && state.moisture >= high) state.pumpOn = false;
}

function readSensor() {
  const noise = (Math.random() - 0.5) * 0.6; // real sensors are noisy
  return Math.round((state.moisture + noise) * 100) / 100;
}

// Accept new thresholds only if the server's signature checks out and the reply
// belongs to the request we just sent. A fake server can't drown the plant.
function applyServerReply(res, sentNonce) {
  const sigB64 = res.headers['x-server-signature'];
  if (!sigB64) return 'no signature';
  const okSig = crypto.verify(null, Buffer.from(res.body), serverPub, Buffer.from(String(sigB64), 'base64'));
  if (!okSig) return 'BAD server signature, ignoring reply';
  const msg = JSON.parse(res.body);
  if (msg.nonce !== sentNonce || msg.deviceId !== device.deviceId) return 'reply not for this request, ignoring';
  if (!(msg.low >= 10 && msg.high <= 95 && msg.high - msg.low >= 5)) return 'unsafe thresholds, ignoring';
  state.thresholds = { low: msg.low, high: msg.high };
  return null;
}

async function send(payload) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const { body, headers } = signedTelemetry(device, payload, { nonce });
  try {
    const res = await request(device.serverUrl + '/api/device/telemetry', { method: 'POST', headers, body, ca });
    if (res.status === 200) return applyServerReply(res, nonce) || 'sent (encrypted)';
    return `server said ${res.status}: ${res.body}`;
  } catch (e) {
    return `offline (${e.code || e.message}), still watering locally`;
  }
}

async function tick() {
  const waterMl = stepPhysics();
  control();
  const moisture = readSensor();
  const t = new Date(state.simTime).toTimeString().slice(0, 5);

  // PIR motion sensor
  if (state.motionPending || Math.random() < MOTION_CHANCE) {
    state.motionPending = false;
    state.ledTicks = LED_TICKS;
    const note = await send({ type: 'motion', sensor: 'pir-1', simTime: state.simTime });
    console.log(`[${t}] PIR: motion detected -> LED ON (red), alert ${note}`);
  }

  const note = await send({ type: 'reading', moisture, pumpOn: state.pumpOn, waterMl, simTime: state.simTime });
  const bar = '#'.repeat(Math.round(moisture / 4)).padEnd(25, '.');
  const led = state.ledTicks > 0 ? 'LED red' : 'LED off';
  if (state.ledTicks > 0) state.ledTicks--;
  console.log(`[${t}] ${bar} ${moisture.toFixed(1).padStart(5)}%  sprinkler ${state.pumpOn ? 'ON ' : 'off'}  ${led}  ${note}`);
}

if (process.stdin.isTTY) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (s) => { if (s.trim().toLowerCase() === 'm') state.motionPending = true; });
}
// Also allow `kill -USR2 <pid>` to trigger motion (used by the demo scripts).
process.on('SIGUSR2', () => { state.motionPending = true; });

console.log(`Virtual node ${device.deviceId} started (pid ${process.pid}). Type "m" + Enter to trigger the motion sensor. Ctrl+C to stop.`);
setInterval(tick, TICK_MS);
tick();
