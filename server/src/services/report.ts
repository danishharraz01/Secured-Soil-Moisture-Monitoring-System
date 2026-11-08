/**
 * Daily summary for one (simulated) calendar day: moisture statistics,
 * waterings, water used, motion events and minutes the device was offline.
 */
import type { PrismaClient } from '../db.js';
import { dayRange, estimateSimNow } from './simclock.js';

export interface DailyReport {
  date: string;
  readings: number;
  avgMoistureMm: number | null;
  minMoistureMm: number | null;
  maxMoistureMm: number | null;
  waterings: number;
  totalWaterMl: number;
  motionCount: number;
  offlineMinutes: number;
}

const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

export async function dailyReport(
  prisma: PrismaClient,
  date: string,
  simFactor: number,
): Promise<DailyReport> {
  const { start, end } = dayRange(date);
  const inDay = { gte: start, lt: end };

  const [stats, waterings, motionCount] = await Promise.all([
    prisma.reading.aggregate({
      where: { ts: inDay },
      _count: { _all: true },
      _avg: { moistureMm: true },
      _min: { moistureMm: true },
      _max: { moistureMm: true },
      _sum: { waterMl: true },
    }),
    prisma.alert.count({ where: { type: 'pump_on', simTime: inDay } }),
    prisma.alert.count({ where: { type: 'motion', simTime: inDay } }),
  ]);

  return {
    date,
    readings: stats._count._all,
    avgMoistureMm: round1(stats._avg.moistureMm),
    minMoistureMm: round1(stats._min.moistureMm),
    maxMoistureMm: round1(stats._max.moistureMm),
    waterings,
    totalWaterMl: stats._sum.waterMl ?? 0,
    motionCount,
    offlineMinutes: await offlineMinutes(prisma, start, end, simFactor),
  };
}

/** Sums offline -> online intervals (simulated time) that overlap [start, end). */
async function offlineMinutes(
  prisma: PrismaClient,
  start: Date,
  end: Date,
  simFactor: number,
): Promise<number> {
  const events = await prisma.alert.findMany({
    where: { type: { in: ['offline', 'online'] }, simTime: { not: null, lt: end } },
    orderBy: { id: 'asc' },
    select: { type: true, simTime: true },
  });
  let total = 0;
  let wentOffline: Date | null = null;
  const add = (from: Date, to: Date): void => {
    const a = Math.max(from.getTime(), start.getTime());
    const b = Math.min(to.getTime(), end.getTime());
    if (b > a) total += b - a;
  };
  for (const e of events) {
    if (e.type === 'offline' && !wentOffline) wentOffline = e.simTime;
    else if (e.type === 'online' && wentOffline && e.simTime) {
      add(wentOffline, e.simTime);
      wentOffline = null;
    }
  }
  if (wentOffline) add(wentOffline, await estimateSimNow(prisma, simFactor)); // still offline
  return Math.round(total / 60_000);
}

export function formatReport(r: DailyReport): string {
  if (r.readings === 0) return `Daily report ${r.date}: no readings`;
  return (
    `Daily report ${r.date}: avg ${r.avgMoistureMm} mm (min ${r.minMoistureMm}, max ${r.maxMoistureMm}), ` +
    `${r.waterings} watering(s), ${r.totalWaterMl} ml water, ${r.motionCount} motion event(s), ` +
    `${r.offlineMinutes} min offline`
  );
}
