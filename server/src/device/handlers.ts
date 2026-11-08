/**
 * What the server does with a verified, decrypted device message
 * (Flow 1 readings, Flow 3 motion, Flow 4 heartbeats).
 */
import type { AppContext } from '../context.js';
import type { Device } from '../db.js';
import { createAlert, mm } from '../services/alerts.js';
import { appendReading } from '../services/chain.js';
import { dailyReport, formatReport } from '../services/report.js';
import { estimateSimNow, localDate } from '../services/simclock.js';
import type { MotionInput, ReadingInput } from './schemas.js';

/** A jump larger than this between two readings is flagged as an anomaly. */
export const ANOMALY_JUMP_MM = 6;

// ---------------------------------------------------------------------------
// Flow 1: reading -> anomaly check -> pump alerts -> hash chain -> syslog INFO
// ---------------------------------------------------------------------------

export async function handleReading(
  ctx: AppContext,
  device: Device,
  p: ReadingInput,
  ip: string,
): Promise<void> {
  const { prisma, keys, syslog, audit } = ctx;
  const prev = await prisma.reading.findFirst({
    where: { deviceId: device.id },
    orderBy: { id: 'desc' },
    select: { moistureMm: true, pumpOn: true, ts: true },
  });
  const simTime = new Date(p.simTime);
  const anomaly = prev !== null && Math.abs(p.moistureMm - prev.moistureMm) > ANOMALY_JUMP_MM;

  const row = await appendReading(prisma, keys, {
    deviceId: device.id,
    ts: simTime,
    moistureMm: p.moistureMm,
    pumpOn: p.pumpOn,
    waterMl: p.waterMl,
    anomaly,
    receivedAt: new Date(),
  });

  // The device clock passed midnight -> daily report line for the finished day.
  // (Simulated midnight in demo mode, real midnight in real-time mode.)
  if (prev && localDate(prev.ts) !== localDate(simTime) && simTime > prev.ts) {
    const report = await dailyReport(prisma, localDate(prev.ts), ctx.simSpeedFactor);
    syslog.log({
      severity: 'notice',
      msgId: 'report',
      message: formatReport(report),
      data: {
        date: report.date,
        avg_mm: report.avgMoistureMm,
        waterings: report.waterings,
        water_ml: report.totalWaterMl,
        motion: report.motionCount,
        offline_min: report.offlineMinutes,
      },
    });
  }

  syslog.log({
    severity: 'info',
    msgId: 'reading',
    message: `Reading #${row.id}: soil ${mm(p.moistureMm)} mm, pump ${p.pumpOn ? 'ON' : 'off'}`,
    data: {
      device: device.id,
      reading: row.id,
      moisture_mm: p.moistureMm,
      pump: p.pumpOn ? 'on' : 'off',
      water_ml: p.waterMl,
    },
  });

  if (anomaly && prev) {
    await audit.record({
      actor: device.id,
      action: 'reading_anomaly',
      detail: `Soil moisture jumped from ${mm(prev.moistureMm)} to ${mm(p.moistureMm)} mm (more than ${ANOMALY_JUMP_MM} mm) at reading #${row.id}`,
      ip,
      msgId: 'reading',
    });
  }

  // Relay state changes -> app notifications.
  const wasOn = prev?.pumpOn ?? false;
  if (!wasOn && p.pumpOn) {
    await createAlert(prisma, {
      type: 'pump_on',
      level: 'info',
      simTime,
      message: `Soil moisture ${mm(p.moistureMm)} mm (<= ${device.low} mm), relay switched the water pump on`,
    });
    syslog.log({
      severity: 'info',
      msgId: 'pump',
      message: `Water pump ON at ${mm(p.moistureMm)} mm`,
      data: { device: device.id, reading: row.id },
    });
  } else if (wasOn && !p.pumpOn) {
    const usedMl = await waterUsedThisCycle(ctx, device.id, row.id);
    await createAlert(prisma, {
      type: 'pump_off',
      level: 'info',
      simTime,
      message: `Soil moisture reached ${mm(p.moistureMm)} mm, water pump switched off (used ${usedMl} ml)`,
    });
    syslog.log({
      severity: 'info',
      msgId: 'pump',
      message: `Water pump OFF at ${mm(p.moistureMm)} mm, used ${usedMl} ml`,
      data: { device: device.id, reading: row.id, water_ml: usedMl },
    });
  }
}

/** Water pumped since the last reading that had the pump off (i.e. this watering cycle). */
async function waterUsedThisCycle(
  ctx: AppContext,
  deviceId: string,
  currentId: number,
): Promise<number> {
  const lastOff = await ctx.prisma.reading.findFirst({
    where: { deviceId, pumpOn: false, id: { lt: currentId } },
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  const sum = await ctx.prisma.reading.aggregate({
    where: { deviceId, id: { gt: lastOff?.id ?? 0, lte: currentId } },
    _sum: { waterMl: true },
  });
  return sum._sum.waterMl ?? 0;
}

// ---------------------------------------------------------------------------
// Flow 3: motion -> alert -> syslog WARNING -> SMS + email (2-minute cooldown)
// ---------------------------------------------------------------------------

export async function handleMotion(ctx: AppContext, device: Device, p: MotionInput): Promise<void> {
  const message = `Motion detected near the celery bed (sensor ${p.sensor}) - red LED is on`;
  await createAlert(ctx.prisma, {
    type: 'motion',
    level: 'warning',
    message,
    simTime: new Date(p.simTime),
  });
  ctx.syslog.log({
    severity: 'warning',
    msgId: 'motion',
    message,
    data: { device: device.id, sensor: p.sensor },
  });

  const result = await ctx.notifier.notify(
    'motion',
    'Motion detected at your celery bed',
    `Soil Monitor: motion detected by ${p.sensor} on ${device.id} at ${new Date().toLocaleString()}. The red LED is on. Check the garden.`,
  );
  if (!result.sent && result.reason === 'cooldown') {
    ctx.syslog.log({
      severity: 'notice',
      msgId: 'motion',
      message: 'SMS/email suppressed (max 1 per 2 minutes)',
      data: { device: device.id },
    });
  }
}

// ---------------------------------------------------------------------------
// Flow 4: heartbeat -> lastSeenAt; offline -> online = "Device reconnected"
// ---------------------------------------------------------------------------

export async function handleHeartbeat(ctx: AppContext, device: Device, ip: string): Promise<void> {
  await ctx.prisma.device.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date(), online: true },
  });
  if (!device.online) {
    const first = device.lastSeenAt === null;
    const message = `Device ${device.id} ${first ? 'connected' : 'reconnected'}`;
    await createAlert(ctx.prisma, {
      type: 'online',
      level: 'info',
      message,
      simTime: await estimateSimNow(ctx.prisma, ctx.simSpeedFactor),
    });
    await ctx.audit.record({
      actor: device.id,
      action: 'device_online',
      detail: message,
      ip,
      msgId: 'device',
      severity: 'notice',
    });
  }
}
