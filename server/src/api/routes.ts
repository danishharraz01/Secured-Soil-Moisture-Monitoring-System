/**
 * App API (all routes need a valid session; admin-only routes say so).
 *
 *   GET  /api/readings?limit=150       latest readings (chart)
 *   GET  /api/devices                  status, last seen, latest reading, water today
 *   GET  /api/config                   thresholds
 *   PUT  /api/config          (admin)  change thresholds (validThresholds)
 *   GET  /api/alerts?since=<id>        notifications
 *   GET  /api/activity?type=&limit=    pump / motion / offline history
 *   GET  /api/report?date=YYYY-MM-DD   daily summary
 *   GET  /api/verify                   walk the hash chain
 *   GET  /api/audit           (admin)  security audit log
 *   GET  /api/me                       who am I + session end
 */
import express from 'express';
import { MOISTURE, THRESHOLD_LIMITS, validThresholds } from '@soil/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { AlertType } from '../db.js';
import { createAlert } from '../services/alerts.js';
import { severityFor } from '../services/audit.js';
import { verifyChain } from '../services/chain.js';
import { dailyReport } from '../services/report.js';
import { dayRange, localDate } from '../services/simclock.js';
import { currentUser, requireAuth, requireRole } from '../auth/session.js';

const ACTIVITY_TYPES = ['pump_on', 'pump_off', 'motion', 'offline', 'online'] as const;

const readingsQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(1000).default(150) })
  .strict();
const alertsQuery = z.object({ since: z.coerce.number().int().min(0).optional() }).strict();
const activityQuery = z
  .object({
    type: z.enum(ACTIVITY_TYPES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
const reportQuery = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((d) => !Number.isNaN(Date.parse(d)), 'invalid date')
      .optional(),
  })
  .strict();
const auditQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
  .strict();
const configBody = z.object({ low: z.number(), high: z.number() }).strict();

/** The single sensor node of this installation (the API is multi-device ready). */
const DEVICE_ID = 'celery-node-01';
const TAMPER_META_KEY = 'tamper_reported';

export function apiRouter(ctx: AppContext): express.Router {
  const router = express.Router();
  const { prisma } = ctx;
  router.use(requireAuth(ctx));

  const bad = (res: express.Response, error: z.ZodError): void => {
    const issue = error.issues[0];
    res.status(400).json({
      error: `Invalid ${issue?.path.join('.') || 'request'}: ${issue?.message ?? ''}`.trim(),
    });
  };

  router.get('/me', (_req, res) => {
    const u = currentUser(res);
    res.json({
      username: u.username,
      role: u.role,
      sessionExpiresAt: u.sessionExpiresAt.toISOString(),
    });
  });

  router.get('/readings', async (req, res) => {
    const q = readingsQuery.safeParse(req.query);
    if (!q.success) return bad(res, q.error);
    const rows = await prisma.reading.findMany({
      orderBy: { id: 'desc' },
      take: q.data.limit,
      select: {
        id: true,
        deviceId: true,
        ts: true,
        moistureMm: true,
        pumpOn: true,
        waterMl: true,
        anomaly: true,
      },
    });
    res.json({ unit: MOISTURE.unit, readings: rows.reverse() });
  });

  router.get('/devices', async (_req, res) => {
    const devices = await prisma.device.findMany({ orderBy: { id: 'asc' } });
    const lastMotion = await prisma.alert.findFirst({
      where: { type: 'motion' },
      orderBy: { id: 'desc' },
    });
    const result = await Promise.all(
      devices.map(async (d) => {
        const latest = await prisma.reading.findFirst({
          where: { deviceId: d.id },
          orderBy: { id: 'desc' },
        });
        let waterTodayMl = 0;
        if (latest) {
          const { start, end } = dayRange(localDate(latest.ts));
          const sum = await prisma.reading.aggregate({
            where: { deviceId: d.id, ts: { gte: start, lt: end } },
            _sum: { waterMl: true },
          });
          waterTodayMl = sum._sum.waterMl ?? 0;
        }
        return {
          id: d.id,
          online: d.online,
          lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
          low: d.low,
          high: d.high,
          latest: latest
            ? {
                id: latest.id,
                ts: latest.ts.toISOString(),
                moistureMm: latest.moistureMm,
                pumpOn: latest.pumpOn,
              }
            : null,
          waterTodayMl,
          lastMotionAt: lastMotion?.at.toISOString() ?? null,
        };
      }),
    );
    res.json({ devices: result, serverTime: new Date().toISOString() });
  });

  router.get('/config', async (_req, res) => {
    const d = await prisma.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    res.json({
      deviceId: d.id,
      unit: MOISTURE.unit,
      low: d.low,
      high: d.high,
      limits: THRESHOLD_LIMITS,
    });
  });

  router.put('/config', requireRole(ctx, 'admin'), async (req, res) => {
    const body = configBody.safeParse(req.body);
    if (!body.success) return bad(res, body.error);
    const { low, high } = body.data;
    const user = currentUser(res);
    if (!validThresholds(low, high)) {
      await ctx.audit.record({
        actor: user.username,
        action: 'config_rejected',
        detail: `invalid thresholds ${low} / ${high} mm`,
        ip: req.ip,
        msgId: 'config',
      });
      return void res.status(400).json({
        error: `Invalid thresholds: need low >= ${THRESHOLD_LIMITS.minLow}, high <= ${THRESHOLD_LIMITS.maxHigh} and high - low >= ${THRESHOLD_LIMITS.minGap} mm`,
      });
    }
    const before = await prisma.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    const d = await prisma.device.update({ where: { id: DEVICE_ID }, data: { low, high } });
    await ctx.audit.record({
      actor: user.username,
      action: 'config_changed',
      detail: `thresholds ${before.low} / ${before.high} -> ${low} / ${high} mm (sent to the device in its next signed reply)`,
      ip: req.ip,
      msgId: 'config',
    });
    res.json({
      deviceId: d.id,
      unit: MOISTURE.unit,
      low: d.low,
      high: d.high,
      limits: THRESHOLD_LIMITS,
    });
  });

  router.get('/alerts', async (req, res) => {
    const q = alertsQuery.safeParse(req.query);
    if (!q.success) return bad(res, q.error);
    const alerts = await prisma.alert.findMany({
      where: q.data.since !== undefined ? { id: { gt: q.data.since } } : {},
      orderBy: { id: 'desc' },
      take: q.data.since !== undefined ? 100 : 20,
    });
    const latest = await prisma.alert.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
    res.json({ alerts, latestId: latest?.id ?? 0 });
  });

  router.get('/activity', async (req, res) => {
    const q = activityQuery.safeParse(req.query);
    if (!q.success) return bad(res, q.error);
    const types: AlertType[] = q.data.type ? [q.data.type] : [...ACTIVITY_TYPES];
    const events = await prisma.alert.findMany({
      where: { type: { in: types } },
      orderBy: { id: 'desc' },
      take: q.data.limit,
    });
    res.json({ events });
  });

  router.get('/report', async (req, res) => {
    const q = reportQuery.safeParse(req.query);
    if (!q.success) return bad(res, q.error);
    let date = q.data.date;
    if (!date) {
      // Default: the device's current (simulated) day.
      const latest = await prisma.reading.findFirst({
        orderBy: { id: 'desc' },
        select: { ts: true },
      });
      date = localDate(latest?.ts ?? new Date());
    }
    res.json(await dailyReport(prisma, date, ctx.simSpeedFactor));
  });

  router.get('/verify', async (req, res) => {
    const result = await verifyChain(prisma, ctx.keys);
    const user = currentUser(res);
    if (result.ok) {
      await prisma.meta.deleteMany({ where: { key: TAMPER_META_KEY } });
      await ctx.audit.record({
        actor: user.username,
        action: 'chain_verified',
        detail: `${result.count} readings OK`,
        ip: req.ip,
        msgId: 'chain',
      });
      return void res.json(result);
    }
    // Tampering: alert + syslog CRIT once per distinct finding (not on every check).
    const finding = `${result.brokenAt}|${result.reason}`;
    const known = await prisma.meta.findUnique({ where: { key: TAMPER_META_KEY } });
    if (known?.value !== finding) {
      await prisma.meta.upsert({
        where: { key: TAMPER_META_KEY },
        create: { key: TAMPER_META_KEY, value: finding },
        update: { value: finding },
      });
      await createAlert(prisma, {
        type: 'tamper',
        level: 'critical',
        message: `Tampering detected at reading #${result.brokenAt ?? '?'}: ${result.reason}`,
      });
      await ctx.audit.record({
        actor: user.username,
        action: 'chain_tamper_detected',
        detail: `reading #${result.brokenAt ?? '?'}: ${result.reason}`,
        ip: req.ip,
        msgId: 'chain',
      });
    }
    res.json(result);
  });

  // Encrypted cloud backup on admin request (also runs every 10 minutes).
  router.post('/backup', requireRole(ctx, 'admin'), async (req, res) => {
    const info = await ctx.backup.run('manual', currentUser(res).username, req.ip);
    res.json(info);
  });

  router.get('/audit', requireRole(ctx, 'admin'), async (req, res) => {
    const q = auditQuery.safeParse(req.query);
    if (!q.success) return bad(res, q.error);
    const rows = await prisma.audit.findMany({ orderBy: { id: 'desc' }, take: q.data.limit });
    res.json({
      entries: rows.map((r) => ({ ...r, suspicious: severityFor(r.action) !== 'notice' })),
    });
  });

  return router;
}
