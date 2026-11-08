/**
 * Crypto helpers shared by the device and the server.
 *
 * Only Node's built-in `node:crypto` is used (OpenSSL underneath) - no custom
 * cryptography. Every function either returns a correct result or throws.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Anything that can be turned into bytes. Strings are treated as UTF-8. */
export type BytesLike = Buffer | Uint8Array | string;

function toBuffer(data: BytesLike): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
}

/** Error thrown when decryption or envelope validation fails. Never contains key material. */
export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

// ---------------------------------------------------------------------------
// Hashing and random values
// ---------------------------------------------------------------------------

/** SHA-256 digest as lowercase hex. */
export function sha256Hex(data: BytesLike): string {
  return createHash('sha256').update(toBuffer(data)).digest('hex');
}

/** Cryptographically secure random bytes as lowercase hex. */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// Key derivation (HKDF-SHA256, RFC 5869)
// ---------------------------------------------------------------------------

/** HKDF `info` labels. Changing a label (e.g. v1 -> v2) rotates the derived key. */
export const KDF_INFO = {
  enc: 'soil enc v1',
  mac: 'soil mac v1',
} as const;

/**
 * HKDF-SHA256. The device secret is already 256 random bits, so an empty salt
 * is acceptable (RFC 5869 section 3.1); the `info` label separates the keys.
 */
export function hkdf(
  ikm: BytesLike,
  info: BytesLike,
  length: number,
  salt: BytesLike = Buffer.alloc(0),
): Buffer {
  return Buffer.from(hkdfSync('sha256', toBuffer(ikm), toBuffer(salt), toBuffer(info), length));
}

export interface DeviceKeys {
  /** AES-128-GCM key for payload encryption. */
  encKey: Buffer;
  /** HMAC-SHA256 key for request signing. */
  macKey: Buffer;
}

/** Derives two independent keys from one device secret (never reuse a key for two jobs). */
export function deriveDeviceKeys(deviceSecret: Buffer | Uint8Array): DeviceKeys {
  if (deviceSecret.length < 32) {
    throw new CryptoError('Device secret must be at least 256 bits');
  }
  return {
    encKey: hkdf(deviceSecret, KDF_INFO.enc, 16),
    macKey: hkdf(deviceSecret, KDF_INFO.mac, 32),
  };
}

// ---------------------------------------------------------------------------
// AES-GCM authenticated encryption
// ---------------------------------------------------------------------------

/** Encrypted payload as it travels over the wire. Binary fields are base64. */
export interface EncryptedEnvelope {
  v: 1;
  alg: 'A128GCM' | 'A256GCM';
  /** 96-bit random IV (never reused with the same key). */
  iv: string;
  ct: string;
  /** 128-bit GCM authentication tag. */
  tag: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function cipherFor(key: Buffer): {
  cipher: 'aes-128-gcm' | 'aes-256-gcm';
  alg: EncryptedEnvelope['alg'];
} {
  if (key.length === 16) return { cipher: 'aes-128-gcm', alg: 'A128GCM' };
  if (key.length === 32) return { cipher: 'aes-256-gcm', alg: 'A256GCM' };
  throw new CryptoError('AES-GCM key must be 16 or 32 bytes');
}

function isBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

/**
 * Type guard: is `value` a well-formed encrypted envelope?
 * Checks shape, base64 encoding and IV/tag lengths - not the key.
 */
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  const keys = Object.keys(e).sort().join(',');
  if (keys !== 'alg,ct,iv,tag,v') return false;
  if (e.v !== 1 || (e.alg !== 'A128GCM' && e.alg !== 'A256GCM')) return false;
  if (!isBase64(e.iv) || !isBase64(e.ct) || !isBase64(e.tag)) return false;
  return (
    Buffer.from(e.iv, 'base64').length === IV_BYTES &&
    Buffer.from(e.tag, 'base64').length === TAG_BYTES
  );
}

/**
 * AES-GCM encrypt. Key length picks AES-128 (16 bytes) or AES-256 (32 bytes).
 * `aad` (additional authenticated data, e.g. the device ID) is not encrypted
 * but is authenticated: decrypting with a different AAD fails.
 */
export function aesGcmEncrypt(
  key: Buffer,
  plaintext: BytesLike,
  aad?: BytesLike,
): EncryptedEnvelope {
  const { cipher: name, alg } = cipherFor(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(name, key, iv, { authTagLength: TAG_BYTES });
  if (aad !== undefined) cipher.setAAD(toBuffer(aad));
  const ct = Buffer.concat([cipher.update(toBuffer(plaintext)), cipher.final()]);
  return {
    v: 1,
    alg,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * AES-GCM decrypt. Throws CryptoError if the envelope is malformed, the key is
 * wrong, the AAD differs, or a single bit of IV/ciphertext/tag was changed.
 */
export function aesGcmDecrypt(key: Buffer, envelope: unknown, aad?: BytesLike): Buffer {
  if (!isEncryptedEnvelope(envelope)) throw new CryptoError('Malformed encrypted envelope');
  const { cipher: name, alg } = cipherFor(key);
  if (envelope.alg !== alg) throw new CryptoError('Envelope algorithm does not match key');

  const decipher = createDecipheriv(name, key, Buffer.from(envelope.iv, 'base64'), {
    authTagLength: TAG_BYTES,
  });
  if (aad !== undefined) decipher.setAAD(toBuffer(aad));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
  } catch {
    // OpenSSL's message ("Unsupported state or unable to authenticate data") is replaced
    // with a clear one; nothing about the key or plaintext is included.
    throw new CryptoError('Decryption failed: authentication tag mismatch');
  }
}

/** Convenience: JSON.stringify + encrypt. */
export function encryptJson(key: Buffer, value: unknown, aad?: BytesLike): EncryptedEnvelope {
  return aesGcmEncrypt(key, JSON.stringify(value), aad);
}

/** Convenience: decrypt + JSON.parse. Returns `unknown` - validate it (zod) before use. */
export function decryptJson(key: Buffer, envelope: unknown, aad?: BytesLike): unknown {
  const plaintext = aesGcmDecrypt(key, envelope, aad).toString('utf8');
  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new CryptoError('Decrypted payload is not valid JSON');
  }
}

// ---------------------------------------------------------------------------
// Request signing (HMAC-SHA256)
// ---------------------------------------------------------------------------

/**
 * The exact string the device signs and the server re-computes:
 *
 *   METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(BODY)
 *
 * Signing method + path + time + nonce + body hash binds the signature to this
 * one request: it cannot be moved to another endpoint, replayed later, or
 * attached to a different body.
 */
export function signingString(
  method: string,
  path: string,
  timestamp: string | number,
  nonce: string,
  body: BytesLike,
): string {
  return [method.toUpperCase(), path, String(timestamp), nonce, sha256Hex(body)].join('\n');
}

/** HMAC-SHA256 as lowercase hex. */
export function hmacSha256Hex(key: Buffer, data: BytesLike): string {
  return createHmac('sha256', key).update(toBuffer(data)).digest('hex');
}

/**
 * Constant-time comparison. The time taken does not depend on where the first
 * differing byte is, so an attacker cannot guess a signature byte by byte.
 * Different lengths return false (length is not secret: signatures are fixed size).
 */
export function constantTimeEqual(a: BytesLike, b: BytesLike): boolean {
  const left = toBuffer(a);
  const right = toBuffer(b);
  if (left.length !== right.length) {
    // Still do a comparison so both branches cost roughly the same.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Verifies a hex HMAC-SHA256 signature in constant time. */
export function verifyHmacHex(key: Buffer, data: BytesLike, signatureHex: string): boolean {
  return constantTimeEqual(hmacSha256Hex(key, data), signatureHex.toLowerCase());
}
