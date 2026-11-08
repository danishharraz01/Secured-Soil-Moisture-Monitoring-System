import { describe, expect, it } from 'vitest';
import { generatePassword, hashPassword, verifyPassword } from '../../src/security/password.js';

describe('scrypt password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const { salt, passHash } = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', salt, passHash)).toBe(true);
    expect(await verifyPassword('correct horsE', salt, passHash)).toBe(false);
  });

  it('uses a different random salt per user (same password -> different hash)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a.salt).not.toBe(b.salt);
    expect(a.passHash).not.toBe(b.passHash);
  });

  it('stores the parameters with the hash and never the password', async () => {
    const { passHash } = await hashPassword('secret-pass');
    expect(passHash).toMatch(/^scrypt\$15\$8\$3\$[0-9a-f]{64}$/);
    expect(passHash).not.toContain('secret-pass');
  });

  it('returns false (does not throw) for malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'abcd', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'abcd', 'scrypt$99$8$1$00')).toBe(false);
    expect(await verifyPassword('x', 'abcd', 'scrypt$15$8$1$')).toBe(false);
  });
});

describe('generatePassword', () => {
  it('produces 4 groups of 5 unambiguous characters', () => {
    expect(generatePassword()).toMatch(/^[A-HJ-NP-Za-km-z2-9]{5}(-[A-HJ-NP-Za-km-z2-9]{5}){3}$/);
  });

  it('is random', () => {
    const set = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(set.size).toBe(50);
  });
});
