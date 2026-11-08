/**
 * Server key material: generation (used by `npm run setup`) and loading
 * (used by the running server).
 *
 *   master.key              AES-256 key - encrypts device secrets at rest, keys OTP HMACs
 *   chain.key               HMAC-SHA256 key for the tamper-evident reading hash chain
 *   signing-ed25519(.pub).pem  signs replies to the device and backup envelopes
 *   backup-rsa3072.pub.pem  wraps backup data keys (PUBLIC key only on the server)
 *   offline-keys/backup-rsa3072.pem  backup PRIVATE key - kept away from the server
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { aesGcmDecrypt, aesGcmEncrypt, isEncryptedEnvelope } from '@soil/shared';
import { PATHS } from '../paths.js';

export interface ServerKeys {
  masterKey: Buffer;
  chainKey: Buffer;
  signingPrivateKey: KeyObject;
  signingPublicKey: KeyObject;
  /** PEM of the Ed25519 public key - given to the device so it can verify replies. */
  signingPublicKeyPem: string;
  backupPublicKey: KeyObject;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** 32 random bytes, base64 encoded, for master.key / chain.key. */
export function generateSymmetricKeyFile(): string {
  return randomBytes(32).toString('base64') + '\n';
}

export function generateEd25519Pem(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export function generateRsa3072Pem(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicExponent: 0x10001,
  });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function readKeyFile(file: string): string {
  if (!existsSync(file)) {
    throw new Error(`Key file missing: ${file} - run "npm run setup" first`);
  }
  return readFileSync(file, 'utf8');
}

function readSymmetricKey(file: string): Buffer {
  const key = Buffer.from(readKeyFile(file).trim(), 'base64');
  if (key.length !== 32) throw new Error(`${file} must contain 32 bytes (base64)`);
  return key;
}

/** Loads and validates every server key. Throws with a helpful message if one is missing. */
export function loadServerKeys(): ServerKeys {
  const signingPrivateKey = createPrivateKey(readKeyFile(PATHS.signingPrivateKey));
  const signingPublicKeyPem = readKeyFile(PATHS.signingPublicKey);
  const signingPublicKey = createPublicKey(signingPublicKeyPem);
  const backupPublicKey = createPublicKey(readKeyFile(PATHS.backupPublicKey));

  if (signingPrivateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('Signing key must be Ed25519');
  if (
    backupPublicKey.asymmetricKeyType !== 'rsa' ||
    backupPublicKey.asymmetricKeyDetails?.modulusLength !== 3072
  ) {
    throw new Error('Backup public key must be RSA-3072');
  }

  return {
    masterKey: readSymmetricKey(PATHS.masterKey),
    chainKey: readSymmetricKey(PATHS.chainKey),
    signingPrivateKey,
    signingPublicKey,
    signingPublicKeyPem,
    backupPublicKey,
  };
}

// ---------------------------------------------------------------------------
// Device secrets at rest
// ---------------------------------------------------------------------------

/** AAD binds the encrypted secret to its device row: copying it to another device ID fails. */
const secretAad = (deviceId: string): string => `device-secret:${deviceId}`;

/** Encrypts a device secret with the master key (AES-256-GCM) for Device.secretEnc. */
export function encryptDeviceSecret(masterKey: Buffer, deviceId: string, secret: Buffer): string {
  return JSON.stringify(aesGcmEncrypt(masterKey, secret, secretAad(deviceId)));
}

/** Decrypts Device.secretEnc. Throws if the master key is wrong or the value was altered. */
export function decryptDeviceSecret(
  masterKey: Buffer,
  deviceId: string,
  secretEnc: string,
): Buffer {
  const envelope: unknown = JSON.parse(secretEnc);
  if (!isEncryptedEnvelope(envelope)) throw new Error('Device secret is not an encrypted envelope');
  return aesGcmDecrypt(masterKey, envelope, secretAad(deviceId));
}
