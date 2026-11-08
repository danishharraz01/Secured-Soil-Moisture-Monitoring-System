/**
 * Flow 2 (login + OTP + 10-minute session) and the app API, against real PostgreSQL.
 */
import { sha256Hex } from '@soil/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerKeys } from '../../src/security/keys.js';
import {
  lastOtp,
  login,
  PASSWORDS,
  reading,
  resetDb,
  seedDevice,
  seedUsers,
  sendDevice,
  testKeys,
  testPrisma,
  testServer,
  type TestServer,
} from './helpers.js';
import type { DeviceKeys } from '@soil/shared';

const prisma = testPrisma();
let keys: ServerKeys;
let deviceKeys: DeviceKeys;
let t: TestServer;

beforeEach(async () => {
  await resetDb(prisma);
  keys = testKeys();
  deviceKeys = await seedDevice(prisma, keys);
  await seedUsers(prisma);
  t = testServer(prisma, keys);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const body = <T>(res: request.Response): T => res.body as T;
type ErrorBody = { error: string; reason?: string; restart?: boolean };

describe('Flow 2: login -> OTP -> session', () => {
  it('logs in with password + emailed OTP and returns a 10-minute session', async () => {
    const step1 = await request(t.app)
      .post('/api/login')
      .send({ username: 'admin', password: PASSWORDS.admin });
    expect(step1.status).toBe(200);
    expect(step1.body).toMatchObject({
      otpRequired: true,
      sentTo: 'o****@test.local',
      expiresIn: 300,
    });
    expect(t.mailer.sent.at(-1)?.to).toBe('owner@test.local');

    const before = Date.now();
    const step2 = await request(t.app)
      .post('/api/login/otp')
      .send({
        challengeId: body<{ challengeId: string }>(step1).challengeId,
        code: lastOtp(t.mailer),
      });
    expect(step2.status).toBe(200);
    const s = body<{ token: string; expiresAt: string; user: unknown }>(step2);
    expect(s.token).toMatch(/^[0-9a-f]{64}$/);
    expect(s.user).toEqual({ username: 'admin', role: 'admin' });
    const lifetime = Date.parse(s.expiresAt) - before;
    expect(lifetime).toBeGreaterThan(9.9 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(10 * 60_000 + 1000);

    // Only the SHA-256 of the token is stored.
    const stored = await prisma.session.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(sha256Hex(s.token));
    expect(JSON.stringify(stored)).not.toContain(s.token);

    const me = await request(t.app).get('/api/me').set(auth(s.token));
    expect(me.body).toMatchObject({ username: 'admin', role: 'admin' });
  });

  it('gives the same generic error for a wrong password and an unknown user', async () => {
    const wrong = await request(t.app)
      .post('/api/login')
      .send({ username: 'admin', password: 'nope' });
    const unknown = await request(t.app)
      .post('/api/login')
      .send({ username: 'mallory', password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(body<ErrorBody>(wrong).error).toBe('Wrong username or password');
    expect(t.mailer.sent).toHaveLength(0);
    expect(await prisma.audit.count({ where: { action: 'login_failed' } })).toBe(2);
  });

  it('ONE wrong OTP invalidates the challenge -> back to login (restart: true)', async () => {
    const step1 = await request(t.app)
      .post('/api/login')
      .send({ username: 'viewer', password: PASSWORDS.viewer });
    const challengeId = body<{ challengeId: string }>(step1).challengeId;
    const code = lastOtp(t.mailer);
    const wrongCode = code === '000000' ? '111111' : '000000';

    const wrong = await request(t.app)
      .post('/api/login/otp')
      .send({ challengeId, code: wrongCode });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ error: 'Wrong code - please log in again', restart: true });

    // The correct code no longer works either.
    const retry = await request(t.app).post('/api/login/otp').send({ challengeId, code });
    expect(retry.status).toBe(401);
    expect(body<ErrorBody>(retry).restart).toBe(true);
    expect(await prisma.audit.count({ where: { action: 'otp_wrong' } })).toBe(1);
  });

  it('an OTP can only be used once', async () => {
    const step1 = await request(t.app)
      .post('/api/login')
      .send({ username: 'admin', password: PASSWORDS.admin });
    const payload = {
      challengeId: body<{ challengeId: string }>(step1).challengeId,
      code: lastOtp(t.mailer),
    };
    expect((await request(t.app).post('/api/login/otp').send(payload)).status).toBe(200);
    const reuse = await request(t.app).post('/api/login/otp').send(payload);
    expect(reuse.status).toBe(401);
    expect(body<ErrorBody>(reuse).restart).toBe(true);
  });

  it('an OTP expires after 5 minutes', async () => {
    const step1 = await request(t.app)
      .post('/api/login')
      .send({ username: 'admin', password: PASSWORDS.admin });
    const challengeId = body<{ challengeId: string }>(step1).challengeId;
    await prisma.otpChallenge.update({
      where: { id: challengeId },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    const res = await request(t.app)
      .post('/api/login/otp')
      .send({ challengeId, code: lastOtp(t.mailer) });
    expect(res.status).toBe(401);
    expect(await prisma.audit.findFirst({ where: { action: 'otp_failed' } })).toMatchObject({
      detail: 'code expired',
    });
  });

  it('stores only an HMAC of the OTP, never the code', async () => {
    await request(t.app).post('/api/login').send({ username: 'admin', password: PASSWORDS.admin });
    const code = lastOtp(t.mailer);
    const row = await prisma.otpChallenge.findFirstOrThrow();
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it('blocks an IP for 5 minutes after 5 failures (429 + Retry-After)', async () => {
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await request(t.app)
            .post('/api/login')
            .send({ username: 'admin', password: `guess${i}` })
        ).status,
      ).toBe(401);
    }
    const blocked = await request(t.app)
      .post('/api/login')
      .send({ username: 'admin', password: PASSWORDS.admin });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(290);
    expect(await prisma.audit.count({ where: { action: 'login_blocked' } })).toBe(1);
  });

  it('logout deletes the session', async () => {
    const { token } = await login(t, 'admin');
    expect((await request(t.app).post('/api/logout').set(auth(token))).status).toBe(200);
    const after = await request(t.app).get('/api/readings').set(auth(token));
    expect(after.status).toBe(401);
    expect(body<ErrorBody>(after).reason).toBe('invalid');
  });
});

describe('sessions', () => {
  it('have a HARD 10-minute limit: no renewal, then 401 reason "expired"', async () => {
    const { token, expiresAt } = await login(t, 'admin');
    await request(t.app).get('/api/readings').set(auth(token));
    const row = await prisma.session.findFirstOrThrow();
    expect(row.expiresAt.toISOString()).toBe(expiresAt); // using the API did not extend it

    await prisma.session.update({
      where: { tokenHash: row.tokenHash },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    const res = await request(t.app).get('/api/readings').set(auth(token));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      reason: 'expired',
      error: 'Session expired (10-minute limit) - please log in again',
    });
    expect(await prisma.session.count()).toBe(0);
  });

  it('reject requests without or with a forged token', async () => {
    const none = await request(t.app).get('/api/readings');
    const forged = await request(t.app)
      .get('/api/readings')
      .set(auth('ab'.repeat(32)));
    expect(none.status).toBe(401);
    expect(body<ErrorBody>(none).reason).toBe('missing');
    expect(forged.status).toBe(401);
    expect(body<ErrorBody>(forged).reason).toBe('invalid');
  });
});

describe('roles (enforced on the server)', () => {
  it('viewer gets 403 for admin actions, and it is audited', async () => {
    const { token } = await login(t, 'viewer');
    const put = await request(t.app)
      .put('/api/config')
      .set(auth(token))
      .send({ low: 10, high: 40 });
    const audit = await request(t.app).get('/api/audit').set(auth(token));
    expect(put.status).toBe(403);
    expect(audit.status).toBe(403);
    expect(await prisma.audit.count({ where: { action: 'forbidden', actor: 'viewer' } })).toBe(2);
    expect((await prisma.device.findFirstOrThrow()).low).toBe(24.5);
  });

  it('viewer can read data', async () => {
    const { token } = await login(t, 'viewer');
    for (const path of [
      '/api/readings',
      '/api/devices',
      '/api/config',
      '/api/alerts',
      '/api/activity',
      '/api/report',
      '/api/verify',
    ]) {
      expect((await request(t.app).get(path).set(auth(token))).status, path).toBe(200);
    }
  });

  it('admin can change thresholds (validated); the device receives them in the signed reply', async () => {
    const { token } = await login(t, 'admin');
    const bad = await request(t.app)
      .put('/api/config')
      .set(auth(token))
      .send({ low: 30, high: 31 });
    expect(bad.status).toBe(400);
    const ok = await request(t.app).put('/api/config').set(auth(token)).send({ low: 22, high: 30 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ low: 22, high: 30 });

    const reply = await sendDevice(t.app, deviceKeys, { type: 'heartbeat', uptime: 3 });
    expect(reply.body).toMatchObject({ low: 22, high: 30 });
    expect(await prisma.audit.findFirst({ where: { action: 'config_changed' } })).not.toBeNull();
  });
});

describe('app API', () => {
  it('readings, devices, alerts and activity', async () => {
    for (const r of [reading(26), reading(24.2, true, 45), reading(32.2, false, 45)])
      await sendDevice(t.app, deviceKeys, r);
    await sendDevice(t.app, deviceKeys, {
      type: 'motion',
      sensor: 'pir-1',
      simTime: new Date().toISOString(),
    });
    const { token } = await login(t, 'viewer');

    const readings = await request(t.app).get('/api/readings?limit=2').set(auth(token));
    expect(
      body<{ readings: { moistureMm: number }[] }>(readings).readings.map((r) => r.moistureMm),
    ).toEqual([24.2, 32.2]);

    const devices = body<{
      devices: {
        online: boolean;
        latest: { moistureMm: number };
        waterTodayMl: number;
        lastMotionAt: string;
      }[];
    }>(await request(t.app).get('/api/devices').set(auth(token))).devices;
    expect(devices[0]).toMatchObject({ latest: { moistureMm: 32.2 }, waterTodayMl: 90 });
    expect(devices[0]?.lastMotionAt).toBeTruthy();

    const alerts = body<{ alerts: { id: number; type: string }[]; latestId: number }>(
      await request(t.app).get('/api/alerts').set(auth(token)),
    );
    expect(alerts.alerts.map((a) => a.type)).toEqual(['motion', 'pump_off', 'pump_on']);
    const since = body<{ alerts: unknown[] }>(
      await request(t.app).get(`/api/alerts?since=${alerts.latestId}`).set(auth(token)),
    );
    expect(since.alerts).toHaveLength(0);

    const motion = body<{ events: { type: string }[] }>(
      await request(t.app).get('/api/activity?type=motion').set(auth(token)),
    );
    expect(motion.events.map((e) => e.type)).toEqual(['motion']);
    expect((await request(t.app).get('/api/activity?type=delete').set(auth(token))).status).toBe(
      400,
    );
    expect((await request(t.app).get('/api/readings?limit=99999').set(auth(token))).status).toBe(
      400,
    );
  });

  it('daily report: average / min / max, waterings, water and motion', async () => {
    const day = new Date(2026, 10, 8, 12, 0);
    const at = (minutes: number) => new Date(day.getTime() + minutes * 60_000).toISOString();
    const send = (p: object) => sendDevice(t.app, deviceKeys, p);
    await send({ ...reading(25), simTime: at(0) });
    await send({ ...reading(24, true, 45), simTime: at(10) });
    await send({ ...reading(32, false, 45), simTime: at(20) });
    await send({ type: 'motion', sensor: 'pir-1', simTime: at(25) });
    const { token } = await login(t, 'admin');
    const r = await request(t.app).get('/api/report?date=2026-11-08').set(auth(token));
    expect(r.body).toEqual({
      date: '2026-11-08',
      readings: 3,
      avgMoistureMm: 27,
      minMoistureMm: 24,
      maxMoistureMm: 32,
      waterings: 1,
      totalWaterMl: 90,
      motionCount: 1,
      offlineMinutes: 0,
    });
    expect((await request(t.app).get('/api/report?date=2026-13-45').set(auth(token))).status).toBe(
      400,
    );
  });

  it('writes a daily report line to syslog when the device clock passes midnight', async () => {
    await sendDevice(t.app, deviceKeys, {
      ...reading(27),
      simTime: new Date(2026, 10, 8, 23, 50).toISOString(),
    });
    await sendDevice(t.app, deviceKeys, {
      ...reading(27),
      simTime: new Date(2026, 10, 9, 0, 0).toISOString(),
    });
    const line = t.syslog.events.find((e) => e.msgId === 'report');
    expect(line?.message).toMatch(/^Daily report 2026-11-08: avg 27 mm/);
  });

  it('/api/verify reports tampering once (critical alert + syslog CRIT)', async () => {
    for (const mm of [27, 26.8, 26.5]) await sendDevice(t.app, deviceKeys, reading(mm));
    const { token } = await login(t, 'viewer');
    expect((await request(t.app).get('/api/verify').set(auth(token))).body).toMatchObject({
      ok: true,
      count: 3,
    });

    await prisma.$executeRaw`UPDATE "Reading" SET "moistureMm" = 45 WHERE id = 2`;
    for (let i = 0; i < 2; i++) {
      const res = await request(t.app).get('/api/verify').set(auth(token));
      expect(res.body).toMatchObject({ ok: false, brokenAt: 2 });
    }
    const tamper = await prisma.alert.findMany({ where: { type: 'tamper' } });
    expect(tamper).toHaveLength(1);
    expect(tamper[0]).toMatchObject({ level: 'critical' });
    expect(tamper[0]?.message).toMatch(/^Tampering detected at reading #2/);
    expect(t.syslog.events.filter((e) => e.severity === 'crit')).toHaveLength(1);
  });

  it('admin sees the audit log with suspicious entries flagged', async () => {
    await request(t.app).post('/api/login').send({ username: 'admin', password: 'wrong' });
    const { token } = await login(t, 'admin');
    const res = body<{ entries: { action: string; suspicious: boolean }[] }>(
      await request(t.app).get('/api/audit').set(auth(token)),
    );
    const failed = res.entries.find((e) => e.action === 'login_failed');
    const ok = res.entries.find((e) => e.action === 'login_success');
    expect(failed?.suspicious).toBe(true);
    expect(ok?.suspicious).toBe(false);
  });

  it('rejects non-JSON bodies and never leaks stack traces', async () => {
    const form = await request(t.app)
      .post('/api/login')
      .set('content-type', 'application/x-www-form-urlencoded')
      .send('username=admin');
    expect(form.status).toBe(415);
    const broken = await request(t.app)
      .post('/api/login')
      .set('content-type', 'application/json')
      .send('{"username":');
    expect(broken.status).toBe(400);
    expect(broken.text).not.toMatch(/at .*\.ts|node_modules|SyntaxError/);
  });
});
