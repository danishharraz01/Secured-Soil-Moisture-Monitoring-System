/** Shared helpers for integration tests (real PostgreSQL, in-memory syslog/mail). */
import { createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDeviceRequest,
  deriveDeviceKeys,
  type BuildRequestOptions,
  type DeviceKeys,
} from '@soil/shared';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import type { AppContext } from '../../src/context.js';
import { createPrisma, type PrismaClient } from '../../src/db.js';
import { loadEnv } from '../../src/env.js';
import { silentLogger } from '../../src/logger.js';
import { encryptDeviceSecret, type ServerKeys } from '../../src/security/keys.js';
import { hashPassword } from '../../src/security/password.js';
import { AuditLog } from '../../src/services/audit.js';
import { BackupService, LocalDirStore } from '../../src/services/backup.js';
import { OwnerNotifier, type Mailer, type SmsSender } from '../../src/services/notify.js';
import { MemorySyslog } from '../../src/services/syslog.js';

loadEnv();
export const DEVICE_ID = 'celery-node-01';

export function testPrisma(): PrismaClient {
  return createPrisma(process.env.TEST_DATABASE_URL);
}

let cachedKeys: ServerKeys | undefined;
/** The backup PRIVATE key that belongs to testKeys() (only tests and restore use it). */
export let testBackupPrivateKey: KeyObject;
/** Fresh in-memory server keys (generated once per test file). */
export function testKeys(): ServerKeys {
  if (cachedKeys) return cachedKeys;
  const ed = generateKeyPairSync('ed25519');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 3072 });
  testBackupPrivateKey = rsa.privateKey;
  cachedKeys = {
    masterKey: randomBytes(32),
    chainKey: randomBytes(32),
    signingPrivateKey: ed.privateKey,
    signingPublicKey: ed.publicKey,
    signingPublicKeyPem: ed.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    backupPublicKey: createPublicKey(rsa.publicKey.export({ type: 'spki', format: 'pem' })),
  };
  return cachedKeys;
}

export async function resetDb(prisma: PrismaClient): Promise<void> {
  // Fixed table list, no user input.
  await prisma.$executeRawUnsafe(
    'TRUNCATE "Reading", "Nonce", "Device", "User", "OtpChallenge", "Session", "Alert", "Audit", "Meta" RESTART IDENTITY CASCADE',
  );
}

/** Creates the device with a random secret (stored encrypted) and returns its derived keys. */
export async function seedDevice(
  prisma: PrismaClient,
  keys: ServerKeys,
  id = DEVICE_ID,
): Promise<DeviceKeys> {
  const secret = randomBytes(32);
  await prisma.device.create({
    data: { id, secretEnc: encryptDeviceSecret(keys.masterKey, id, secret), low: 24.5, high: 32 },
  });
  return deriveDeviceKeys(secret);
}

export async function seedOwner(prisma: PrismaClient): Promise<void> {
  await prisma.user.create({
    data: {
      username: 'admin',
      role: 'admin',
      email: 'owner@test.local',
      phone: '+60111111111',
      salt: '00',
      passHash: 'x',
    },
  });
}

export class MemoryMailer implements Mailer {
  readonly description = 'memory';
  readonly sent: { to: string; subject: string; text: string }[] = [];
  send(to: string, subject: string, text: string): Promise<void> {
    this.sent.push({ to, subject, text });
    return Promise.resolve();
  }
}

export class MemorySms implements SmsSender {
  readonly description = 'memory';
  readonly sent: { to: string; text: string }[] = [];
  send(to: string, text: string): Promise<void> {
    this.sent.push({ to, text });
    return Promise.resolve();
  }
}

export interface TestServer {
  ctx: AppContext;
  app: Express;
  syslog: MemorySyslog;
  mailer: MemoryMailer;
  sms: MemorySms;
  /** Temporary folder that receives this server's backups. */
  cloudDir: string;
}

export function testServer(prisma: PrismaClient, keys: ServerKeys, backupKeep = 20): TestServer {
  const syslog = new MemorySyslog();
  const mailer = new MemoryMailer();
  const sms = new MemorySms();
  const audit = new AuditLog(prisma, syslog, silentLogger);
  const cloudDir = mkdtempSync(path.join(os.tmpdir(), 'soil-cloud-'));
  const ctx: AppContext = {
    prisma,
    keys,
    syslog,
    audit,
    notifier: new OwnerNotifier(prisma, mailer, sms, silentLogger),
    backup: new BackupService(
      prisma,
      keys,
      new LocalDirStore(cloudDir),
      audit,
      silentLogger,
      backupKeep,
    ),
    logger: silentLogger,
    startedAt: Date.now(),
    simSpeedFactor: 600,
  };
  return { ctx, app: createApp(ctx), syslog, mailer, sms, cloudDir };
}

/** Sends a device request exactly like the real device (overrides allow attacks). */
export function sendDevice(
  app: Express,
  deviceKeys: DeviceKeys,
  payload: unknown,
  overrides: Partial<BuildRequestOptions> & {
    headers?: Record<string, string>;
    body?: string;
  } = {},
): request.Test {
  const req = buildDeviceRequest({ deviceId: DEVICE_ID, keys: deviceKeys, payload, ...overrides });
  return request(app)
    .post(req.path)
    .set({ ...req.headers, ...overrides.headers })
    .send(overrides.body ?? req.body);
}

export const reading = (moistureMm: number, pumpOn = false, waterMl = 0) => ({
  type: 'reading' as const,
  moistureMm,
  pumpOn,
  waterMl,
  simTime: new Date().toISOString(),
});

// ---------------------------------------------------------------------------
// Users and login (Phase 4)
// ---------------------------------------------------------------------------

export const PASSWORDS = { admin: 'Admin-Test-Pass-1', viewer: 'Viewer-Test-Pass-1' } as const;

/** admin + viewer with real scrypt hashes. */
export async function seedUsers(prisma: PrismaClient): Promise<void> {
  const users = [
    { username: 'admin', role: 'admin' as const, email: 'owner@test.local', phone: '+60111111111' },
    { username: 'viewer', role: 'viewer' as const, email: 'viewer@test.local', phone: null },
  ];
  for (const u of users) {
    const { salt, passHash } = await hashPassword(PASSWORDS[u.username as keyof typeof PASSWORDS]);
    await prisma.user.create({ data: { ...u, salt, passHash } });
  }
}

/** The 6-digit code from the newest OTP email. */
export function lastOtp(mailer: MemoryMailer): string {
  const match = /code is: (\d{6})/.exec(mailer.sent.at(-1)?.text ?? '');
  if (!match?.[1]) throw new Error('no OTP email sent');
  return match[1];
}

/** Full Flow 2 login: password -> OTP from the captured email -> session token. */
export async function login(
  t: TestServer,
  username: 'admin' | 'viewer',
): Promise<{ token: string; expiresAt: string }> {
  const step1 = await request(t.app)
    .post('/api/login')
    .send({ username, password: PASSWORDS[username] });
  if (step1.status !== 200) throw new Error(`login failed: ${step1.status} ${step1.text}`);
  const { challengeId } = step1.body as { challengeId: string };
  const step2 = await request(t.app)
    .post('/api/login/otp')
    .send({ challengeId, code: lastOtp(t.mailer) });
  if (step2.status !== 200) throw new Error(`otp failed: ${step2.status} ${step2.text}`);
  return step2.body as { token: string; expiresAt: string };
}
