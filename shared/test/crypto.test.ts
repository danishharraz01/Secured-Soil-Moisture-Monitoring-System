import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  constantTimeEqual,
  CryptoError,
  decryptJson,
  deriveDeviceKeys,
  encryptJson,
  hkdf,
  hmacSha256Hex,
  isEncryptedEnvelope,
  sha256Hex,
  signingString,
  verifyHmacHex,
  type EncryptedEnvelope,
} from '../src/index.js';

/** Flips one bit in a base64 field and returns the new base64 string. */
function flipBit(b64: string, byteIndex = 0): string {
  const buf = Buffer.from(b64, 'base64');
  buf[byteIndex] = (buf[byteIndex] ?? 0) ^ 0x01;
  return buf.toString('base64');
}

describe('HKDF key derivation', () => {
  it('matches the RFC 5869 test case 1 vector', () => {
    const ikm = Buffer.alloc(22, 0x0b);
    const salt = Buffer.from('000102030405060708090a0b0c', 'hex');
    const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex');
    const okm = hkdf(ikm, info, 42, salt);
    expect(okm.toString('hex')).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('derives different 16-byte enc and 32-byte mac keys from one secret', () => {
    const { encKey, macKey } = deriveDeviceKeys(randomBytes(32));
    expect(encKey).toHaveLength(16);
    expect(macKey).toHaveLength(32);
    expect(encKey.equals(macKey.subarray(0, 16))).toBe(false);
  });

  it('is deterministic for the same secret', () => {
    const secret = randomBytes(32);
    expect(deriveDeviceKeys(secret).encKey.equals(deriveDeviceKeys(secret).encKey)).toBe(true);
  });

  it('rejects secrets shorter than 256 bits', () => {
    expect(() => deriveDeviceKeys(randomBytes(16))).toThrow(CryptoError);
  });
});

describe('AES-GCM encryption', () => {
  const key128 = randomBytes(16);
  const key256 = randomBytes(32);
  const aad = 'celery-node-01';

  it('round-trips with AES-128-GCM', () => {
    const env = aesGcmEncrypt(key128, 'moisture 27.3 mm', aad);
    expect(env.alg).toBe('A128GCM');
    expect(aesGcmDecrypt(key128, env, aad).toString()).toBe('moisture 27.3 mm');
  });

  it('round-trips with AES-256-GCM', () => {
    const env = aesGcmEncrypt(key256, 'backup data');
    expect(env.alg).toBe('A256GCM');
    expect(aesGcmDecrypt(key256, env).toString()).toBe('backup data');
  });

  it('round-trips JSON', () => {
    const payload = { type: 'reading', moistureMm: 27.3, pumpOn: false };
    expect(decryptJson(key128, encryptJson(key128, payload, aad), aad)).toEqual(payload);
  });

  it('uses a fresh random IV every time (same plaintext -> different ciphertext)', () => {
    const a = aesGcmEncrypt(key128, 'same', aad);
    const b = aesGcmEncrypt(key128, 'same', aad);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('does not leak the plaintext in the envelope', () => {
    const env = aesGcmEncrypt(key128, 'moisture 27.3 mm', aad);
    expect(JSON.stringify(env)).not.toContain('27.3');
  });

  it.each([
    ['ciphertext', 'ct'],
    ['IV', 'iv'],
    ['auth tag', 'tag'],
  ] as const)('detects a single flipped bit in the %s', (_label, field) => {
    const env = aesGcmEncrypt(key128, 'moisture 27.3 mm', aad);
    const tampered: EncryptedEnvelope = { ...env, [field]: flipBit(env[field]) };
    expect(() => aesGcmDecrypt(key128, tampered, aad)).toThrow(CryptoError);
  });

  it('fails with the wrong key', () => {
    const env = aesGcmEncrypt(key128, 'secret', aad);
    expect(() => aesGcmDecrypt(randomBytes(16), env, aad)).toThrow(/authentication tag/);
  });

  it('fails when the AAD (device ID) differs', () => {
    const env = aesGcmEncrypt(key128, 'secret', 'celery-node-01');
    expect(() => aesGcmDecrypt(key128, env, 'celery-node-02')).toThrow(CryptoError);
  });

  it('rejects a key whose size does not match the envelope algorithm', () => {
    const env = aesGcmEncrypt(key128, 'secret');
    expect(() => aesGcmDecrypt(key256, env)).toThrow(/does not match/);
  });

  it('rejects invalid key sizes', () => {
    expect(() => aesGcmEncrypt(randomBytes(24), 'x')).toThrow(CryptoError);
  });
});

describe('isEncryptedEnvelope', () => {
  const env = aesGcmEncrypt(randomBytes(16), 'x');

  it('accepts a real envelope', () => {
    expect(isEncryptedEnvelope(env)).toBe(true);
  });

  it.each([
    ['plain JSON reading', { type: 'reading', moistureMm: 20 }],
    ['null', null],
    ['array', [env]],
    ['string', JSON.stringify(env)],
    ['extra field', { ...env, moistureMm: 20 }],
    ['wrong version', { ...env, v: 2 }],
    ['unknown algorithm', { ...env, alg: 'A128CBC' }],
    ['non-base64 ciphertext', { ...env, ct: 'not base64!' }],
    ['short IV', { ...env, iv: Buffer.alloc(8).toString('base64') }],
    ['truncated tag', { ...env, tag: Buffer.alloc(4).toString('base64') }],
  ])('rejects %s', (_label, value) => {
    expect(isEncryptedEnvelope(value)).toBe(false);
  });

  it('makes aesGcmDecrypt throw on malformed input', () => {
    expect(() => aesGcmDecrypt(randomBytes(16), { type: 'reading' })).toThrow(/Malformed/);
  });
});

describe('Request signing (HMAC-SHA256)', () => {
  const macKey = randomBytes(32);
  const body = '{"deviceId":"celery-node-01"}';

  it('builds METHOD\\nPATH\\nTIMESTAMP\\nNONCE\\nSHA256(BODY)', () => {
    const s = signingString('post', '/api/device/telemetry', 1700000000000, 'ab'.repeat(16), body);
    expect(s.split('\n')).toEqual([
      'POST',
      '/api/device/telemetry',
      '1700000000000',
      'ab'.repeat(16),
      sha256Hex(body),
    ]);
  });

  it('matches the RFC 4231 HMAC-SHA256 test case 2 vector', () => {
    expect(hmacSha256Hex(Buffer.from('Jefe'), 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('verifies a valid signature', () => {
    const s = signingString('POST', '/api/device/telemetry', 1, 'n', body);
    expect(verifyHmacHex(macKey, s, hmacSha256Hex(macKey, s))).toBe(true);
  });

  it('rejects a signature over a different body, nonce, timestamp or path', () => {
    const sig = hmacSha256Hex(macKey, signingString('POST', '/p', 1, 'n', body));
    expect(verifyHmacHex(macKey, signingString('POST', '/p', 1, 'n', body + ' '), sig)).toBe(false);
    expect(verifyHmacHex(macKey, signingString('POST', '/p', 1, 'm', body), sig)).toBe(false);
    expect(verifyHmacHex(macKey, signingString('POST', '/p', 2, 'n', body), sig)).toBe(false);
    expect(verifyHmacHex(macKey, signingString('POST', '/q', 1, 'n', body), sig)).toBe(false);
  });

  it('rejects a signature made with a different key', () => {
    const s = signingString('POST', '/p', 1, 'n', body);
    expect(verifyHmacHex(macKey, s, hmacSha256Hex(randomBytes(32), s))).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('compares equal and different values', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });

  it('returns false (does not throw) for different lengths', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });

  it('works with Buffers', () => {
    expect(constantTimeEqual(Buffer.from([1, 2]), Buffer.from([1, 2]))).toBe(true);
  });
});
