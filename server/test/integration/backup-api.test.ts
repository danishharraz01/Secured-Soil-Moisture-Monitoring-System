/**
 * POST /api/backup (admin) + scheduled-backup retention, against real PostgreSQL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceKeys } from '@soil/shared';
import type { ServerKeys } from '../../src/security/keys.js';
import { openBackup } from '../../src/services/backup.js';
import {
  login,
  reading,
  resetDb,
  seedDevice,
  seedUsers,
  sendDevice,
  testBackupPrivateKey,
  testKeys,
  testPrisma,
  testServer,
} from './helpers.js';

const prisma = testPrisma();
let keys: ServerKeys;
let deviceKeys: DeviceKeys;

beforeEach(async () => {
  await resetDb(prisma);
  keys = testKeys();
  deviceKeys = await seedDevice(prisma, keys);
  await seedUsers(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('encrypted cloud backup', () => {
  it('admin creates a backup that only the offline key can open', async () => {
    const t = testServer(prisma, keys);
    for (const mm of [27, 26.8, 26.5]) await sendDevice(t.app, deviceKeys, reading(mm));
    const { token } = await login(t, 'admin');

    const res = await request(t.app).post('/api/backup').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ readings: 3 });

    const file = path.join(t.cloudDir, (res.body as { file: string }).file);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('celery-node-01');

    const opened = openBackup(raw, {
      signingPublicKey: keys.signingPublicKey,
      backupPrivateKey: testBackupPrivateKey,
      chainKey: keys.chainKey,
    });
    expect(opened.ok).toBe(true);
    expect(opened.ok && opened.plaintext.readings.map((r) => r.moistureMm)).toEqual([
      27, 26.8, 26.5,
    ]);
    expect(
      await prisma.audit.findFirst({ where: { action: 'backup_created', actor: 'admin' } }),
    ).not.toBeNull();
  });

  it('viewer cannot trigger a backup (403, audited)', async () => {
    const t = testServer(prisma, keys);
    const { token } = await login(t, 'viewer');
    const res = await request(t.app).post('/api/backup').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(readdirSync(t.cloudDir)).toHaveLength(0);
    expect(await prisma.audit.count({ where: { action: 'forbidden', actor: 'viewer' } })).toBe(1);
  });

  it('keeps only the newest N backups', async () => {
    const t = testServer(prisma, keys, 2);
    for (let i = 0; i < 4; i++) {
      await t.ctx.backup.run('scheduled', 'system');
      await new Promise((r) => setTimeout(r, 5)); // distinct timestamps in file names
    }
    expect(readdirSync(t.cloudDir)).toHaveLength(2);
  });
});
