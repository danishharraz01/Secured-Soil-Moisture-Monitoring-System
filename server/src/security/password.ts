/**
 * Password hashing with scrypt (memory-hard, built into Node).
 *
 * Stored format in User.passHash:  scrypt$<logN>$<r>$<p>$<hex hash>
 * The parameters travel with the hash, so they can be raised later without
 * breaking existing users. The random per-user salt is stored in User.salt.
 */
import { randomBytes, randomInt, scrypt as scryptCb, type ScryptOptions } from 'node:crypto';
import { constantTimeEqual } from '@soil/shared';

/**
 * N = 2^15, r = 8, p = 3: one of the equivalent minimum configurations in the
 * OWASP Password Storage Cheat Sheet (~32 MiB memory per hash).
 */
export const SCRYPT_PARAMS = { logN: 15, r: 8, p: 3, keyLen: 32, saltBytes: 16 } as const;

function scrypt(
  password: string,
  salt: Buffer,
  keyLen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function options(logN: number, r: number, p: number): ScryptOptions {
  const N = 2 ** logN;
  // Memory needed is 128 * N * r bytes; allow twice that.
  return { N, r, p, maxmem: 256 * N * r };
}

export interface PasswordHash {
  salt: string;
  passHash: string;
}

/** Hashes a password with a fresh random salt. */
export async function hashPassword(password: string): Promise<PasswordHash> {
  const { logN, r, p, keyLen, saltBytes } = SCRYPT_PARAMS;
  const salt = randomBytes(saltBytes);
  const key = await scrypt(password, salt, keyLen, options(logN, r, p));
  return {
    salt: salt.toString('hex'),
    passHash: `scrypt$${logN}$${r}$${p}$${key.toString('hex')}`,
  };
}

/**
 * Checks a password in constant time. Returns false (never throws) for a
 * malformed stored hash, so a corrupted row cannot crash the login route.
 */
export async function verifyPassword(
  password: string,
  saltHex: string,
  passHash: string,
): Promise<boolean> {
  const parts = passHash.split('$');
  if (parts.length !== 5 || parts[0] !== 'scrypt') return false;
  const [logN, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const expected = Buffer.from(parts[4] ?? '', 'hex');
  if (![logN, r, p].every(Number.isInteger) || logN > 20 || expected.length === 0) return false;

  const key = await scrypt(
    password,
    Buffer.from(saltHex, 'hex'),
    expected.length,
    options(logN, r, p),
  );
  return constantTimeEqual(key, expected);
}

/** Unambiguous alphabet (no 0/O, 1/l/I) so generated passwords are easy to type. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * Random password like "Kp7Qx-mN3rT-9vWbZ-hJ4sd": 20 characters from a
 * 57-character alphabet = ~117 bits of entropy (crypto.randomInt, no modulo bias).
 */
export function generatePassword(groups = 4, groupLen = 5): string {
  return Array.from({ length: groups }, () =>
    Array.from({ length: groupLen }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
  ).join('-');
}
