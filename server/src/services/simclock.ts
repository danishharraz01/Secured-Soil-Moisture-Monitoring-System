/**
 * The device clock runs 600x faster in demo mode (1 s = 10 min). Events the
 * server creates itself (offline / online) are stamped with the device's
 * estimated simulated time, so reports per simulated day stay consistent.
 */
import type { PrismaClient } from '../db.js';

export const SIM_FACTOR = { demo: 600, realtime: 1 } as const;

export async function estimateSimNow(
  prisma: PrismaClient,
  factor: number,
  now = new Date(),
): Promise<Date> {
  const last = await prisma.reading.findFirst({
    orderBy: { id: 'desc' },
    select: { ts: true, receivedAt: true },
  });
  if (!last) return now;
  // Never earlier than the newest reading (e.g. a heartbeat from before it).
  const elapsed = Math.max(0, now.getTime() - last.receivedAt.getTime());
  return new Date(last.ts.getTime() + elapsed * factor);
}

/** Local calendar date "YYYY-MM-DD" of a timestamp. */
export function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** [start, end) of a local calendar day. */
export function dayRange(date: string): { start: Date; end: Date } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { start: new Date(y, m - 1, d), end: new Date(y, m - 1, d + 1) };
}
