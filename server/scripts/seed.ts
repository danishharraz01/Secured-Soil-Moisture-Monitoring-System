/**
 * `npm run seed` - preloads the last 24 hours so the chart, activity list and
 * daily report are not empty on a fresh install.
 *
 *  - 144 readings (one per 10 minutes) produced by the device's own physics
 *    and pump controller, so the data looks exactly like the real thing
 *  - every reading goes through the normal hash chain (verify stays OK)
 *  - pump on/off alerts with the water used, two motion events and one
 *    30-minute disconnection
 *
 * Only runs on an empty Reading table, because older readings must not be
 * appended after newer ones. `npm run seed -- --fresh` clears the monitoring
 * data first (users, passwords, keys and the device are kept).
 */
import { MOISTURE } from '@soil/shared';
import { decidePump } from '../../device/src/controller.js';
import { advanceSoil, sensorRead, type Rng } from '../../device/src/physics.js';
import type { AlertLevel, AlertType, PrismaClient } from '../src/db.js';
import { loadEnv, requireEnv } from '../src/env.js';
import { loadServerKeys } from '../src/security/keys.js';
import { mm } from '../src/services/alerts.js';
import { appendReading } from '../src/services/chain.js';
import { ensureDatabase } from './database.js';
import { out } from './lib/files.js';
import { DEVICE_ID } from './lib/setup.js';

const STEP_MIN = 10;
const STEPS = 144; // 24 hours

/** Small deterministic PRNG (mulberry32) so every seed looks the same. */
function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seed(prisma: PrismaClient): Promise<void> {
  const device = await prisma.device.findUnique({ where: { id: DEVICE_ID } });
  if (!device) throw new Error(`Device ${DEVICE_ID} not found - run "npm run setup" first`);
  if (process.argv.includes('--fresh')) {
    // Clears monitoring data only - users, passwords, keys and the device stay.
    // Fixed SQL, no user input.
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Reading", "Alert", "Audit", "Nonce", "Meta", "OtpChallenge", "Session" RESTART IDENTITY',
    );
    out.done(
      '--fresh: readings, alerts, audit log, sessions and chain head cleared (users and keys kept)',
    );
  }
  const existing = await prisma.reading.count();
  if (existing > 0) {
    out.warn(`The database already has ${existing} readings - nothing seeded.`);
    out.info('Use "npm run seed -- --fresh" (keeps users and keys) or "npm run reset".');
    return;
  }

  const keys = loadServerKeys();
  const rng = seededRng(2022);
  const now = Date.now();
  const start = new Date(Math.floor((now - STEPS * STEP_MIN * 60_000) / 600_000) * 600_000);

  const alert = (type: AlertType, level: AlertLevel, message: string, at: Date) =>
    prisma.alert.create({ data: { type, level, message, at, simTime: at } });

  let trueMm = 29;
  let pumpOn = false;
  let cycleWater = 0;
  let waterTotal = 0;
  let waterings = 0;

  for (let i = 0; i < STEPS; i++) {
    const ts = new Date(start.getTime() + i * STEP_MIN * 60_000);
    const step = advanceSoil(trueMm, pumpOn, ts, STEP_MIN, rng);
    trueMm = step.moistureMm;
    const measured = sensorRead(trueMm, rng);
    const waterMl = Math.round(step.waterMl);
    const next = decidePump(pumpOn, measured, device.low, device.high);

    await appendReading(prisma, keys, {
      deviceId: DEVICE_ID,
      ts,
      moistureMm: measured,
      pumpOn: next,
      waterMl,
      anomaly: false,
      receivedAt: ts,
    });

    cycleWater += waterMl;
    waterTotal += waterMl;
    if (!pumpOn && next) {
      waterings++;
      cycleWater = 0;
      await alert(
        'pump_on',
        'info',
        `Soil moisture ${mm(measured)} mm (<= ${device.low} mm), relay switched the water pump on`,
        ts,
      );
    } else if (pumpOn && !next) {
      await alert(
        'pump_off',
        'info',
        `Soil moisture reached ${mm(measured)} mm, water pump switched off (used ${cycleWater} ml)`,
        ts,
      );
    }
    pumpOn = next;

    // A few events along the day.
    if (i === 40 || i === 118) {
      await alert(
        'motion',
        'warning',
        'Motion detected near the celery bed (sensor pir-1) - red LED is on',
        ts,
      );
    }
    if (i === 70) await alert('offline', 'critical', `Device ${DEVICE_ID} disconnected`, ts);
    if (i === 73) await alert('online', 'info', `Device ${DEVICE_ID} reconnected`, ts);
  }

  await prisma.audit.create({
    data: {
      actor: 'system',
      action: 'demo_data_seeded',
      detail: `${STEPS} readings over 24 h (npm run seed)`,
    },
  });

  out.done(
    `${STEPS} readings from ${start.toLocaleString()} (one per ${STEP_MIN} min), all in the hash chain`,
  );
  out.done(
    `${waterings} watering cycles (${waterTotal} ml), 2 motion events, 1 disconnection of 30 min`,
  );
  out.info(
    `Thresholds used: ON <= ${device.low} mm, OFF >= ${device.high} mm (default ${MOISTURE.defaultLow}/${MOISTURE.defaultHigh})`,
  );
}

async function main(): Promise<number> {
  console.log('\x1b[1mSecured Soil Moisture Monitoring System - seed demo data\x1b[0m');
  loadEnv();
  const db = await ensureDatabase(requireEnv('DATABASE_URL'), out.info);
  const { createPrisma } = await import('../src/db.js');
  const prisma = createPrisma();
  try {
    out.step('Seeding the last 24 hours');
    await seed(prisma);
    return 0;
  } finally {
    await prisma.$disconnect();
    await db.stop();
  }
}

main().then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(`\n\x1b[31mSeed failed:\x1b[0m ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
