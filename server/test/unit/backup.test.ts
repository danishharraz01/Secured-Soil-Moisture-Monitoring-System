/**
 * Encrypted backup: seal (server, public key only) -> open (offline private key).
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  openBackup,
  sealBackup,
  type BackupEnvelope,
  type BackupPlaintext,
  type BackupReading,
  type RestoreResult,
} from '../../src/services/backup.js';
import { chainHash, GENESIS_HASH } from '../../src/services/chain.js';

const ed = generateKeyPairSync('ed25519');
const rsa = generateKeyPairSync('rsa', { modulusLength: 3072 });
const otherRsa = generateKeyPairSync('rsa', { modulusLength: 3072 });
const chainKey = randomBytes(32);

const sealKeys = { backupPublicKey: rsa.publicKey, signingPrivateKey: ed.privateKey };
const openKeys = { signingPublicKey: ed.publicKey, backupPrivateKey: rsa.privateKey, chainKey };

/** Three properly chained readings. */
function plaintext(): BackupPlaintext {
  const readings: BackupReading[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= 3; i++) {
    const fields = {
      deviceId: 'celery-node-01',
      ts: new Date(Date.UTC(2026, 10, 8, 0, i * 10)),
      moistureMm: 25 + i,
      pumpOn: false,
      waterMl: 0,
      anomaly: false,
      receivedAt: new Date(Date.UTC(2026, 10, 8, 0, 0, i)),
    };
    const hash = chainHash(chainKey, prev, fields);
    readings.push({
      id: i,
      ...fields,
      ts: fields.ts.toISOString(),
      receivedAt: fields.receivedAt.toISOString(),
      prevHash: prev,
      hash,
    });
    prev = hash;
  }
  return {
    createdAt: '2026-11-08T10:00:00.000Z',
    head: { lastId: 3, hash: prev, count: 3 },
    readings,
  };
}

const sealed = (): BackupEnvelope => sealBackup(plaintext(), sealKeys);
/** The error message of a failed restore ('' when it unexpectedly succeeded). */
const errorOf = (r: RestoreResult): string => (r.ok ? '' : r.error);
const flip = (b64: string): string => {
  const buf = Buffer.from(b64, 'base64');
  buf[buf.length - 1]! ^= 1;
  return buf.toString('base64');
};

describe('encrypted backup', () => {
  it('round-trips: all five checks pass and the data comes back unchanged', () => {
    const result = openBackup(JSON.stringify(sealed()), openKeys);
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      'Format',
      'Ed25519 signature',
      'RSA-3072-OAEP unwrap',
      'AES-256-GCM tag',
      'SHA-256 of plaintext',
      'Hash chain',
    ]);
    expect(result.ok && result.plaintext).toEqual(plaintext());
  });

  it('contains no readable data - only ciphertext and metadata', () => {
    const text = JSON.stringify(sealed());
    expect(text).not.toContain('celery-node-01');
    expect(text).not.toContain('moistureMm');
    const env = sealed();
    expect(env.alg).toEqual({
      keyWrap: 'RSA-OAEP-3072-SHA256',
      data: 'AES-256-GCM',
      signature: 'Ed25519',
    });
    expect(Buffer.from(env.wrappedKey, 'base64')).toHaveLength(384); // 3072-bit RSA block
  });

  it('uses a fresh data key every time', () => {
    expect(sealed().wrappedKey).not.toBe(sealed().wrappedKey);
    expect(sealed().data.ct).not.toBe(sealed().data.ct);
  });

  it('rejects a modified envelope (signature)', () => {
    const env = { ...sealed(), readingCount: 9999 };
    expect(errorOf(openBackup(JSON.stringify(env), openKeys))).toMatch(/^Ed25519 signature/);
  });

  it('rejects modified ciphertext (signature no longer matches)', () => {
    const env = sealed();
    env.data = { ...env.data, ct: flip(env.data.ct) };
    expect(openBackup(JSON.stringify(env), openKeys).ok).toBe(false);
  });

  it('cannot be opened with the wrong private key', () => {
    const result = openBackup(JSON.stringify(sealed()), {
      ...openKeys,
      backupPrivateKey: otherRsa.privateKey,
    });
    expect(errorOf(result)).toMatch(/^RSA-3072-OAEP unwrap/);
  });

  it('detects modified ciphertext even when the attacker can re-sign (GCM tag)', () => {
    // Worst case: the signing key leaked. Without the data key, a valid GCM tag is impossible.
    const { signature: _old, ...env } = sealed();
    const tampered = { ...env, data: { ...env.data, ct: flip(env.data.ct) } };
    const signature = sign(
      null,
      Buffer.from(`soil backup v1\n${canonicalJson(tampered)}`),
      ed.privateKey,
    ).toString('base64');
    const result = openBackup(JSON.stringify({ ...tampered, signature }), openKeys);
    expect(errorOf(result)).toMatch(/^AES-256-GCM tag/);
  });

  it('detects a broken hash chain inside the backup', () => {
    const p = plaintext();
    p.readings[1] = { ...p.readings[1]!, moistureMm: 49 }; // edited before the backup was made
    const result = openBackup(JSON.stringify(sealBackup(p, sealKeys)), openKeys);
    expect(result).toMatchObject({
      ok: false,
      error: 'Hash chain: reading #2 does not match its HMAC',
    });
  });

  it('detects missing newest readings (head mismatch) even without the chain key', () => {
    const p = plaintext();
    p.readings.pop();
    const { chainKey: _k, ...noChainKey } = openKeys;
    const result = openBackup(JSON.stringify(sealBackup(p, sealKeys)), noChainKey);
    expect(result).toMatchObject({
      ok: false,
      error: 'Hash chain: head does not match the last reading',
    });
  });

  it('rejects files that are not backups', () => {
    expect(openBackup('not json', openKeys).ok).toBe(false);
    expect(openBackup('{"format":"other"}', openKeys).ok).toBe(false);
  });

  it('canonical JSON sorts keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});
