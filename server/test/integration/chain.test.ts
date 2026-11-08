/**
 * Hash chain tamper detection against real PostgreSQL: an attacker with
 * direct database access edits, deletes, reorders or truncates readings.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendReading, signHead, verifyChain } from '../../src/services/chain.js';
import type { ServerKeys } from '../../src/security/keys.js';
import { DEVICE_ID, resetDb, seedDevice, testKeys, testPrisma } from './helpers.js';

const prisma = testPrisma();
let keys: ServerKeys;

async function seedReadings(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await appendReading(prisma, keys, {
      deviceId: DEVICE_ID,
      ts: new Date(Date.UTC(2026, 10, 8, 0, i * 10)),
      moistureMm: 25 + i,
      pumpOn: false,
      waterMl: 0,
      anomaly: false,
      receivedAt: new Date(),
    });
  }
}

beforeEach(async () => {
  await resetDb(prisma);
  keys = testKeys();
  await seedDevice(prisma, keys);
  await seedReadings(5);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('hash chain', () => {
  it('verifies an untouched chain', async () => {
    expect(await verifyChain(prisma, keys)).toEqual({ ok: true, count: 5, lastId: 5 });
  });

  it('links each reading to the previous hash', async () => {
    const rows = await prisma.reading.findMany({ orderBy: { id: 'asc' } });
    expect(rows[0]?.prevHash).toBe('0'.repeat(64));
    for (let i = 1; i < rows.length; i++) expect(rows[i]?.prevHash).toBe(rows[i - 1]?.hash);
  });

  it('detects an edited value', async () => {
    await prisma.$executeRaw`UPDATE "Reading" SET "moistureMm" = 40 WHERE id = 3`;
    expect(await verifyChain(prisma, keys)).toMatchObject({
      ok: false,
      brokenAt: 3,
      reason: 'Reading #3 was modified',
    });
  });

  it('detects an edited value even if the attacker recomputes a plain SHA-256', async () => {
    // Without the secret chain key the attacker cannot produce a valid HMAC.
    await prisma.$executeRaw`UPDATE "Reading" SET "pumpOn" = true, hash = encode(sha256('fake'::bytea), 'hex') WHERE id = 2`;
    expect(await verifyChain(prisma, keys)).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('detects a deleted reading in the middle', async () => {
    await prisma.$executeRaw`DELETE FROM "Reading" WHERE id = 3`;
    expect(await verifyChain(prisma, keys)).toMatchObject({ ok: false, brokenAt: 4 });
  });

  it('detects reordered readings', async () => {
    await prisma.$executeRaw`UPDATE "Reading" SET id = 99 WHERE id = 2`;
    await prisma.$executeRaw`UPDATE "Reading" SET id = 2 WHERE id = 4`;
    await prisma.$executeRaw`UPDATE "Reading" SET id = 4 WHERE id = 99`;
    expect(await verifyChain(prisma, keys)).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('detects deletion of the newest readings (signed head)', async () => {
    await prisma.$executeRaw`DELETE FROM "Reading" WHERE id >= 4`;
    const result = await verifyChain(prisma, keys);
    expect(result).toMatchObject({ ok: false, brokenAt: 5 });
    expect(!result.ok && result.reason).toMatch(/Newest readings were deleted/);
  });

  it('detects a forged head (attacker cannot sign without the server key)', async () => {
    await prisma.$executeRaw`DELETE FROM "Reading" WHERE id >= 4`;
    const last = await prisma.reading.findFirstOrThrow({ orderBy: { id: 'desc' } });
    const forged = {
      lastId: last.id,
      hash: last.hash,
      count: 3,
      signedAt: new Date().toISOString(),
      sig: 'AAAA',
    };
    await prisma.meta.update({
      where: { key: 'chain_head' },
      data: { value: JSON.stringify(forged) },
    });
    expect(await verifyChain(prisma, keys)).toMatchObject({
      ok: false,
      reason: 'Chain head signature is invalid',
    });
  });

  it('accepts a head re-signed by the real server key (sanity check of the signature)', async () => {
    const head = {
      lastId: 5,
      hash: (await prisma.reading.findFirstOrThrow({ where: { id: 5 } })).hash,
      count: 5,
    };
    const sig = signHead(keys.signingPrivateKey, head);
    await prisma.meta.update({
      where: { key: 'chain_head' },
      data: { value: JSON.stringify({ ...head, signedAt: '', sig }) },
    });
    expect((await verifyChain(prisma, keys)).ok).toBe(true);
  });
});
