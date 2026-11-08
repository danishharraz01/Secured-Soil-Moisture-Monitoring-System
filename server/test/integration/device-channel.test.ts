/**
 * POST /api/device/telemetry against a real PostgreSQL database.
 */
import { randomBytes } from 'node:crypto';
import {
  buildDeviceRequest,
  checkServerReply,
  deriveDeviceKeys,
  hmacSha256Hex,
  PROTOCOL,
  signingString,
  type DeviceKeys,
} from '@soil/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DeviceWatcher } from '../../src/device/watcher.js';
import type { ServerKeys } from '../../src/security/keys.js';
import {
  DEVICE_ID,
  reading,
  resetDb,
  seedDevice,
  seedOwner,
  sendDevice,
  testKeys,
  testPrisma,
  testServer,
  type TestServer,
} from './helpers.js';

const prisma = testPrisma();
let keys: ServerKeys;
let deviceKeys: DeviceKeys;
let t: TestServer;

beforeEach(async () => {
  await resetDb(prisma);
  keys = testKeys();
  deviceKeys = await seedDevice(prisma, keys);
  await seedOwner(prisma);
  t = testServer(prisma, keys);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Last audit row + last syslog event, to check every rejection is recorded. */
async function lastRejection() {
  const audit = await prisma.audit.findFirst({ orderBy: { id: 'desc' } });
  const syslog = t.syslog.events.at(-1);
  return { audit, syslog };
}

describe('accepted messages', () => {
  it('stores an encrypted, signed reading and replies with a signed, nonce-bound answer', async () => {
    const req = buildDeviceRequest({
      deviceId: DEVICE_ID,
      keys: deviceKeys,
      payload: reading(27.3),
    });
    const res = await request(t.app).post(req.path).set(req.headers).send(req.body);

    expect(res.status).toBe(200);
    const check = checkServerReply({
      body: res.text,
      signature: res.headers[PROTOCOL.headers.serverSignature],
      publicKey: keys.signingPublicKey,
      expectedDeviceId: DEVICE_ID,
      expectedNonce: req.nonce,
    });
    expect(check).toMatchObject({ ok: true, reply: { low: 24.5, high: 32 } });

    const stored = await prisma.reading.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ moistureMm: 27.3, pumpOn: false, anomaly: false });
    expect(t.syslog.events.at(-1)).toMatchObject({ severity: 'info', msgId: 'reading' });
  });

  it('sends security headers and never reveals the framework', async () => {
    const res = await sendDevice(t.app, deviceKeys, reading(27));
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('rejections (checked in order, audited, syslog WARNING)', () => {
  it.each([
    [
      'SQL injection in device ID',
      400,
      'invalid_device_id',
      { headers: { 'x-device-id': "celery' OR '1'='1" } },
    ],
    ['unknown device', 401, 'unknown_device', { headers: { 'x-device-id': 'celery-node-99' } }],
    ['5-minute-old request', 401, 'stale_timestamp', { timestamp: Date.now() - 5 * 60_000 }],
    ['request from the future', 401, 'stale_timestamp', { timestamp: Date.now() + 60_000 }],
    ['malformed nonce', 400, 'bad_nonce', { nonce: 'abc' }],
    ['no signature', 401, 'missing_signature', { headers: { 'x-signature': '' } }],
  ] as const)('%s -> %i (%s)', async (_label, status, code, overrides) => {
    const res = await sendDevice(t.app, deviceKeys, reading(27), overrides);
    expect(res.status).toBe(status);
    const { audit, syslog } = await lastRejection();
    expect(audit).toMatchObject({ action: 'device_rejected' });
    expect(audit?.detail).toContain(code);
    expect(syslog).toMatchObject({ severity: 'warning', msgId: 'device' });
    expect(await prisma.reading.count()).toBe(0);
  });

  it('signature made with the wrong key -> 401', async () => {
    const res = await sendDevice(t.app, deriveDeviceKeys(randomBytes(32)), reading(27));
    expect(res.status).toBe(401);
    expect((res.body as { error?: string }).error).toBe('Invalid signature');
  });

  it('ciphertext modified in transit (signature no longer matches) -> 401', async () => {
    const req = buildDeviceRequest({ deviceId: DEVICE_ID, keys: deviceKeys, payload: reading(27) });
    const env = JSON.parse(req.body) as { ct: string };
    const ct = Buffer.from(env.ct, 'base64');
    ct[0]! ^= 1;
    const tampered = JSON.stringify({ ...env, ct: ct.toString('base64') });
    const res = await request(t.app).post(req.path).set(req.headers).send(tampered);
    expect(res.status).toBe(401);
  });

  it('modified ciphertext even with a valid signature -> 400 (GCM tag fails)', async () => {
    const req = buildDeviceRequest({ deviceId: DEVICE_ID, keys: deviceKeys, payload: reading(27) });
    const env = JSON.parse(req.body) as { ct: string };
    const ct = Buffer.from(env.ct, 'base64');
    ct[0]! ^= 1;
    const body = JSON.stringify({ ...env, ct: ct.toString('base64') });
    const sig = hmacSha256Hex(
      deviceKeys.macKey,
      signingString('POST', req.path, req.timestamp, req.nonce, body),
    );
    const res = await request(t.app)
      .post(req.path)
      .set({ ...req.headers, 'x-signature': sig })
      .send(body);
    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toMatch(/Decryption failed/);
  });

  it('unencrypted payload with a VALID signature -> 400 "Payload must be encrypted"', async () => {
    const body = JSON.stringify(reading(27));
    const ts = Date.now();
    const nonce = randomBytes(16).toString('hex');
    const sig = hmacSha256Hex(
      deviceKeys.macKey,
      signingString('POST', PROTOCOL.telemetryPath, ts, nonce, body),
    );
    const res = await request(t.app)
      .post(PROTOCOL.telemetryPath)
      .set({
        'content-type': 'application/json',
        'x-device-id': DEVICE_ID,
        'x-timestamp': String(ts),
        'x-nonce': nonce,
        'x-signature': sig,
      })
      .send(body);
    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toBe('Payload must be encrypted');
  });

  it('replayed request -> 409', async () => {
    const req = buildDeviceRequest({ deviceId: DEVICE_ID, keys: deviceKeys, payload: reading(27) });
    const first = await request(t.app).post(req.path).set(req.headers).send(req.body);
    const replay = await request(t.app).post(req.path).set(req.headers).send(req.body);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(await prisma.reading.count()).toBe(1);
    expect((await lastRejection()).audit?.detail).toContain('replay');
  });

  it.each([
    ['moisture 450 mm', { ...reading(27), moistureMm: 450 }],
    ['negative water', { ...reading(27), waterMl: -5 }],
    ['unknown field', { ...reading(27), admin: true }],
    ['unknown type', { type: 'reboot' }],
    [
      'fake motion with a script sensor name',
      { type: 'motion', sensor: '<script>', simTime: new Date().toISOString() },
    ],
  ])('%s -> 422', async (_label, payload) => {
    const res = await sendDevice(t.app, deviceKeys, payload);
    expect(res.status).toBe(422);
    expect((res.body as { error?: string }).error).toMatch(/^Invalid payload/);
  });

  it('5 KB payload -> 413', async () => {
    const res = await sendDevice(t.app, deviceKeys, { ...reading(27), pad: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
    expect((await lastRejection()).audit?.detail).toContain('payload_too_large');
  });
});

describe('Flow 1: pump notifications and anomalies', () => {
  it('creates pump_on and pump_off alerts with the water used', async () => {
    for (const r of [
      reading(26),
      reading(24.4, true, 45),
      reading(28, true, 45),
      reading(32.1, false, 45),
      reading(31.8),
    ]) {
      expect((await sendDevice(t.app, deviceKeys, r)).status).toBe(200);
    }
    const alerts = await prisma.alert.findMany({ orderBy: { id: 'asc' } });
    expect(alerts.map((a) => a.type)).toEqual(['pump_on', 'pump_off']);
    expect(alerts[0]?.message).toBe(
      'Soil moisture 24.4 mm (<= 24.5 mm), relay switched the water pump on',
    );
    expect(alerts[1]?.message).toBe(
      'Soil moisture reached 32.1 mm, water pump switched off (used 135 ml)',
    );
  });

  it('flags a jump of more than 6 mm as an anomaly (audit + syslog WARNING)', async () => {
    await sendDevice(t.app, deviceKeys, reading(30));
    await sendDevice(t.app, deviceKeys, reading(20));
    const rows = await prisma.reading.findMany({ orderBy: { id: 'asc' } });
    expect(rows.map((r) => r.anomaly)).toEqual([false, true]);
    expect(await prisma.audit.findFirst({ where: { action: 'reading_anomaly' } })).not.toBeNull();
  });
});

describe('Flow 3: motion', () => {
  it('alerts, logs WARNING and notifies the owner by SMS + email at most once per 2 minutes', async () => {
    const motion = { type: 'motion', sensor: 'pir-1', simTime: new Date().toISOString() };
    expect((await sendDevice(t.app, deviceKeys, motion)).status).toBe(200);
    expect((await sendDevice(t.app, deviceKeys, motion)).status).toBe(200);

    expect(await prisma.alert.count({ where: { type: 'motion', level: 'warning' } })).toBe(2);
    expect(
      t.syslog.events.filter((e) => e.msgId === 'motion' && e.severity === 'warning'),
    ).toHaveLength(2);
    expect(t.mailer.sent).toHaveLength(1);
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]?.to).toBe('+60111111111');
  });
});

describe('Flow 4: heartbeat, offline and reconnect', () => {
  it('goes online, offline after 30 s of silence (CRIT + SMS/email), then reconnects', async () => {
    const watcher = new DeviceWatcher(t.ctx);
    await sendDevice(t.app, deviceKeys, { type: 'heartbeat', uptime: 1 });
    expect(await prisma.device.findUnique({ where: { id: DEVICE_ID } })).toMatchObject({
      online: true,
    });

    // Not yet 30 s -> still online.
    expect(await watcher.checkOffline(new Date(Date.now() + 20_000))).toEqual([]);
    // 31 s later -> offline, once.
    expect(await watcher.checkOffline(new Date(Date.now() + 31_000))).toEqual([DEVICE_ID]);
    expect(await watcher.checkOffline(new Date(Date.now() + 40_000))).toEqual([]);

    const offline = await prisma.alert.findFirst({ where: { type: 'offline' } });
    expect(offline).toMatchObject({
      level: 'critical',
      message: `Device ${DEVICE_ID} disconnected`,
    });
    expect(
      t.syslog.events.some((e) => e.severity === 'crit' && e.message.startsWith('device_offline')),
    ).toBe(true);
    expect(t.mailer.sent.at(-1)?.subject).toContain('disconnected');
    expect(t.sms.sent).toHaveLength(1);

    await sendDevice(t.app, deviceKeys, { type: 'heartbeat', uptime: 45 });
    const online = await prisma.alert.findMany({
      where: { type: 'online' },
      orderBy: { id: 'asc' },
    });
    expect(online.map((a) => a.message)).toEqual([
      `Device ${DEVICE_ID} connected`,
      `Device ${DEVICE_ID} reconnected`,
    ]);
    expect(t.syslog.events.at(-1)).toMatchObject({ severity: 'notice' });
  });

  it('purges nonces older than 10 minutes', async () => {
    await sendDevice(t.app, deviceKeys, { type: 'heartbeat', uptime: 1 });
    const watcher = new DeviceWatcher(t.ctx);
    expect(await watcher.purgeNonces(new Date(Date.now() + 5 * 60_000))).toBe(0);
    expect(await watcher.purgeNonces(new Date(Date.now() + 11 * 60_000))).toBe(1);
  });
});
