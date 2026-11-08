/**
 * Encrypted cloud backup (Flow 2: "every 10 minutes the data is encrypted,
 * signed and stored in the cloud").
 *
 *   1. plaintext  = JSON {createdAt, head, readings}
 *   2. data key   = 32 fresh random bytes  -> AES-256-GCM(plaintext)
 *   3. wrappedKey = RSA-3072-OAEP-SHA256(data key) with the PUBLIC key only.
 *                   The private key lives in offline-keys/ - the server
 *                   itself cannot decrypt its own backups.
 *   4. envelope   = {format, createdAt, alg, wrappedKey, data, plaintextSha256, ...}
 *   5. signature  = Ed25519(server key) over the canonical envelope
 *
 * Restore checks, in order: signature -> unwrap with the offline private key
 * -> AES-GCM tag -> SHA-256 of the plaintext -> hash chain links.
 */
import {
  constants,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  hmacSha256Hex,
  sha256Hex,
  type EncryptedEnvelope,
} from '@soil/shared';
import type { PrismaClient } from '../db.js';
import type { Logger } from '../logger.js';
import type { AuditLog } from './audit.js';
import { canonicalReading, GENESIS_HASH } from './chain.js';

export const BACKUP_FORMAT = 'soil-backup-v1';
const SIGN_CONTEXT = 'soil backup v1\n';

// ---------------------------------------------------------------------------
// Envelope format
// ---------------------------------------------------------------------------

export interface BackupReading {
  id: number;
  deviceId: string;
  ts: string;
  moistureMm: number;
  pumpOn: boolean;
  waterMl: number;
  anomaly: boolean;
  receivedAt: string;
  prevHash: string;
  hash: string;
}

export interface BackupPlaintext {
  createdAt: string;
  /** The signed chain head at backup time (null when there are no readings). */
  head: { lastId: number; hash: string; count: number } | null;
  readings: BackupReading[];
}

export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  alg: { keyWrap: 'RSA-OAEP-3072-SHA256'; data: 'AES-256-GCM'; signature: 'Ed25519' };
  /** Non-secret metadata so a backup can be identified without decrypting it. */
  readingCount: number;
  wrappedKey: string;
  data: EncryptedEnvelope;
  plaintextSha256: string;
  signature: string;
}

/** JSON with sorted keys at every level - the exact bytes that are signed. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const signingBytes = (unsigned: Omit<BackupEnvelope, 'signature'>): Buffer =>
  Buffer.from(SIGN_CONTEXT + canonicalJson(unsigned), 'utf8');

/** AAD binds the ciphertext to its envelope's format and creation time. */
const aadFor = (createdAt: string): string => `${BACKUP_FORMAT}|${createdAt}`;

export interface SealKeys {
  backupPublicKey: KeyObject;
  signingPrivateKey: KeyObject;
}

export function sealBackup(plaintext: BackupPlaintext, keys: SealKeys): BackupEnvelope {
  const json = JSON.stringify(plaintext);
  const dataKey = randomBytes(32);
  try {
    const unsigned: Omit<BackupEnvelope, 'signature'> = {
      format: BACKUP_FORMAT,
      createdAt: plaintext.createdAt,
      alg: { keyWrap: 'RSA-OAEP-3072-SHA256', data: 'AES-256-GCM', signature: 'Ed25519' },
      readingCount: plaintext.readings.length,
      wrappedKey: publicEncrypt(
        { key: keys.backupPublicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        dataKey,
      ).toString('base64'),
      data: aesGcmEncrypt(dataKey, json, aadFor(plaintext.createdAt)),
      plaintextSha256: sha256Hex(json),
    };
    const signature = sign(null, signingBytes(unsigned), keys.signingPrivateKey).toString('base64');
    return { ...unsigned, signature };
  } finally {
    dataKey.fill(0); // do not keep the data key in memory longer than needed
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface OpenKeys {
  signingPublicKey: KeyObject;
  backupPrivateKey: KeyObject;
  /** Optional: with the chain key every reading HMAC is re-computed too. */
  chainKey?: Buffer;
}

export interface RestoreCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export type RestoreResult =
  | { ok: true; checks: RestoreCheck[]; plaintext: BackupPlaintext }
  | { ok: false; checks: RestoreCheck[]; error: string };

/** Verifies and decrypts a backup. Stops at the first failing check. */
export function openBackup(raw: string, keys: OpenKeys): RestoreResult {
  const checks: RestoreCheck[] = [];
  const fail = (name: string, error: string): RestoreResult => {
    checks.push({ name, ok: false, detail: error });
    return { ok: false, checks, error: `${name}: ${error}` };
  };

  let env: BackupEnvelope;
  try {
    env = JSON.parse(raw) as BackupEnvelope;
  } catch {
    return fail('Format', 'not valid JSON');
  }
  if (env?.format !== BACKUP_FORMAT || typeof env.signature !== 'string' || typeof env.wrappedKey !== 'string') {
    return fail('Format', `not a ${BACKUP_FORMAT} file`);
  }
  checks.push({ name: 'Format', ok: true, detail: BACKUP_FORMAT });

  // 1. Ed25519 signature over everything except the signature itself.
  const { signature, ...unsigned } = env;
  let sigOk = false;
  try {
    sigOk = verify(null, signingBytes(unsigned), keys.signingPublicKey, Buffer.from(signature, 'base64'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail('Ed25519 signature', 'INVALID - the file was modified or not made by this server');
  checks.push({ name: 'Ed25519 signature', ok: true, detail: 'valid (server key)' });

  // 2. Unwrap the data key with the OFFLINE private key.
  let dataKey: Buffer;
  try {
    dataKey = privateDecrypt(
      { key: keys.backupPrivateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(env.wrappedKey, 'base64'),
    );
  } catch {
    return fail('RSA-3072-OAEP unwrap', 'failed - wrong private key?');
  }
  if (dataKey.length !== 32) return fail('RSA-3072-OAEP unwrap', 'data key has the wrong size');
  checks.push({ name: 'RSA-3072-OAEP unwrap', ok: true, detail: 'data key recovered with offline-keys/' });

  // 3. AES-256-GCM decryption (authentication tag).
  let json: string;
  try {
    json = aesGcmDecrypt(dataKey, env.data, aadFor(env.createdAt)).toString('utf8');
  } catch {
    return fail('AES-256-GCM tag', 'INVALID - ciphertext was modified');
  } finally {
    dataKey.fill(0);
  }
  checks.push({ name: 'AES-256-GCM tag', ok: true, detail: 'valid' });

  // 4. SHA-256 of the plaintext.
  if (sha256Hex(json) !== env.plaintextSha256) return fail('SHA-256 of plaintext', 'mismatch');
  checks.push({ name: 'SHA-256 of plaintext', ok: true, detail: `${env.plaintextSha256.slice(0, 16)}…` });

  // 5. Hash chain links (and HMACs when the chain key is available).
  let plaintext: BackupPlaintext;
  try {
    plaintext = JSON.parse(json) as BackupPlaintext;
  } catch {
    return fail('Contents', 'decrypted data is not valid JSON');
  }
  const chainError = checkChain(plaintext, keys.chainKey);
  if (chainError) return fail('Hash chain', chainError);
  checks.push({
    name: 'Hash chain',
    ok: true,
    detail: `${plaintext.readings.length} readings linked${keys.chainKey ? ', every HMAC re-computed' : ''}, head matches`,
  });

  return { ok: true, checks, plaintext };
}

function checkChain(p: BackupPlaintext, chainKey?: Buffer): string | undefined {
  let prev = GENESIS_HASH;
  for (const r of p.readings) {
    if (r.prevHash !== prev) return `link broken before reading #${r.id}`;
    if (chainKey) {
      const fields = { ...r, ts: new Date(r.ts), receivedAt: new Date(r.receivedAt) };
      if (hmacSha256Hex(chainKey, `${r.prevHash}\n${canonicalReading(fields)}`) !== r.hash) {
        return `reading #${r.id} does not match its HMAC`;
      }
    }
    prev = r.hash;
  }
  const last = p.readings.at(-1);
  if (!p.head) return last ? 'head missing' : undefined;
  if (!last || p.head.lastId !== last.id || p.head.hash !== last.hash || p.head.count !== p.readings.length) {
    return 'head does not match the last reading';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Storage (local folder today; S3-ready interface)
// ---------------------------------------------------------------------------

/** Where backups are kept. An S3 implementation would use PutObject/ListObjectsV2/DeleteObject. */
export interface BackupStore {
  readonly description: string;
  put(name: string, content: string): Promise<void>;
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}

export class LocalDirStore implements BackupStore {
  readonly description: string;
  constructor(private readonly dir: string) {
    this.description = `${path.basename(dir)}/`;
  }
  async put(name: string, content: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, name), content, { mode: 0o600 });
  }
  async list(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((f) => /^backup-[\w-]+\.json$/.test(f)).sort();
    } catch {
      return [];
    }
  }
  async remove(name: string): Promise<void> {
    await rm(path.join(this.dir, name), { force: true });
  }
  async read(name: string): Promise<string> {
    return readFile(path.join(this.dir, name), 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Service: scheduled + on-demand backups
// ---------------------------------------------------------------------------

export interface BackupInfo {
  file: string;
  createdAt: string;
  readings: number;
  bytes: number;
}

export class BackupService {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<BackupInfo> | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly keys: SealKeys,
    readonly store: BackupStore,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
    private readonly keep = 20,
  ) {}

  start(intervalMs: number): void {
    this.timer = setInterval(() => {
      this.run('scheduled', 'system').catch((e: unknown) => this.logger.error({ err: e }, 'Scheduled backup failed'));
    }, intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Creates one backup. Concurrent calls share the same run. */
  run(trigger: 'scheduled' | 'manual', actor: string, ip?: string): Promise<BackupInfo> {
    this.running ??= this.create(trigger, actor, ip).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async create(trigger: string, actor: string, ip?: string): Promise<BackupInfo> {
    const createdAt = new Date().toISOString();
    const [rows, meta] = await this.prisma.$transaction([
      this.prisma.reading.findMany({ orderBy: { id: 'asc' } }),
      this.prisma.meta.findUnique({ where: { key: 'chain_head' } }),
    ]);
    const head = meta ? (JSON.parse(meta.value) as { lastId: number; hash: string; count: number }) : null;
    const plaintext: BackupPlaintext = {
      createdAt,
      head: head ? { lastId: head.lastId, hash: head.hash, count: head.count } : null,
      readings: rows.map((r) => ({
        id: r.id,
        deviceId: r.deviceId,
        ts: r.ts.toISOString(),
        moistureMm: r.moistureMm,
        pumpOn: r.pumpOn,
        waterMl: r.waterMl,
        anomaly: r.anomaly,
        receivedAt: r.receivedAt.toISOString(),
        prevHash: r.prevHash,
        hash: r.hash,
      })),
    };

    const content = `${JSON.stringify(sealBackup(plaintext, this.keys), null, 2)}\n`;
    const file = `backup-${createdAt.replace(/[:.]/g, '-')}.json`;
    await this.store.put(file, content);

    // Keep only the newest N backups.
    const all = await this.store.list();
    for (const old of all.slice(0, Math.max(0, all.length - this.keep))) await this.store.remove(old);

    const info: BackupInfo = { file, createdAt, readings: rows.length, bytes: Buffer.byteLength(content) };
    await this.audit.record({
      actor,
      action: 'backup_created',
      detail: `${trigger} backup ${file}: ${rows.length} readings, ${Math.round(info.bytes / 1024)} KB, AES-256-GCM + RSA-3072-OAEP, Ed25519-signed`,
      ip,
      msgId: 'backup',
    });
    return info;
  }
}
