/**
 * Tamper-evident storage for readings (an HMAC hash chain).
 *
 *   hash(n) = HMAC-SHA256(chainKey, hash(n-1) + "\n" + canonical fields of reading n)
 *
 *  - Editing any field of a stored reading changes its hash      -> detected
 *  - Deleting or reordering a row breaks the next row's prevHash  -> detected
 *  - Deleting the NEWEST rows leaves a valid shorter chain, so the head
 *    (last id, last hash, count) is stored in Meta signed with the server's
 *    Ed25519 key. A head that does not match the chain end   -> detected
 *
 * Someone with database access but without the server keys cannot recompute
 * HMACs or re-sign the head.
 */
import { sign, verify, type KeyObject } from 'node:crypto';
import { hmacSha256Hex } from '@soil/shared';
import type { PrismaClient, Reading } from '../db.js';

export const GENESIS_HASH = '0'.repeat(64);
const HEAD_KEY = 'chain_head';
const HEAD_CONTEXT = 'soil chain head v1\n';
/** Serialises appends so two concurrent readings can never fork the chain. */
const APPEND_LOCK_ID = 4_202_611;

export interface ChainFields {
  deviceId: string;
  ts: Date;
  moistureMm: number;
  pumpOn: boolean;
  waterMl: number;
  anomaly: boolean;
  receivedAt: Date;
}

export interface ChainHead {
  lastId: number;
  hash: string;
  count: number;
}

interface StoredHead extends ChainHead {
  signedAt: string;
  sig: string;
}

/** Stable, unambiguous serialisation of the fields protected by the chain. */
export function canonicalReading(f: ChainFields): string {
  return JSON.stringify([
    'v1',
    f.deviceId,
    f.ts.toISOString(),
    f.moistureMm,
    f.pumpOn,
    f.waterMl,
    f.anomaly,
    f.receivedAt.toISOString(),
  ]);
}

export function chainHash(chainKey: Buffer, prevHash: string, f: ChainFields): string {
  return hmacSha256Hex(chainKey, `${prevHash}\n${canonicalReading(f)}`);
}

const headMessage = (h: ChainHead): Buffer =>
  Buffer.from(HEAD_CONTEXT + JSON.stringify([h.lastId, h.hash, h.count]), 'utf8');

export function signHead(privateKey: KeyObject, head: ChainHead): string {
  return sign(null, headMessage(head), privateKey).toString('base64');
}

export function verifyHeadSignature(publicKey: KeyObject, head: ChainHead, sig: string): boolean {
  try {
    return verify(null, headMessage(head), publicKey, Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}

export interface ChainKeys {
  chainKey: Buffer;
  signingPrivateKey: KeyObject;
  signingPublicKey: KeyObject;
}

function parseHead(value: string | undefined): StoredHead | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as StoredHead;
  } catch {
    return undefined;
  }
}

/** Appends one reading to the chain and moves the signed head - atomically. */
export async function appendReading(
  prisma: PrismaClient,
  keys: ChainKeys,
  fields: ChainFields,
): Promise<Reading> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${APPEND_LOCK_ID})::text`;

    const last = await tx.reading.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true, hash: true },
    });
    const prevHash = last?.hash ?? GENESIS_HASH;
    const hash = chainHash(keys.chainKey, prevHash, fields);
    const row = await tx.reading.create({ data: { ...fields, prevHash, hash } });

    const meta = await tx.meta.findUnique({ where: { key: HEAD_KEY } });
    const previous = parseHead(meta?.value);
    const count =
      previous && previous.hash === prevHash ? previous.count + 1 : await tx.reading.count();
    const head: ChainHead = { lastId: row.id, hash, count };
    const stored: StoredHead = {
      ...head,
      signedAt: new Date().toISOString(),
      sig: signHead(keys.signingPrivateKey, head),
    };
    await tx.meta.upsert({
      where: { key: HEAD_KEY },
      create: { key: HEAD_KEY, value: JSON.stringify(stored) },
      update: { value: JSON.stringify(stored) },
    });
    return row;
  });
}

export type VerifyResult =
  | { ok: true; count: number; lastId: number | null }
  | { ok: false; count: number; brokenAt: number | null; reason: string };

/** Walks the whole chain (in batches) and checks the signed head. */
export async function verifyChain(prisma: PrismaClient, keys: ChainKeys): Promise<VerifyResult> {
  let expectedPrev = GENESIS_HASH;
  let count = 0;
  let lastId: number | null = null;
  let cursor = 0;

  for (;;) {
    const batch = await prisma.reading.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: 2000,
    });
    if (batch.length === 0) break;
    for (const r of batch) {
      if (r.prevHash !== expectedPrev) {
        return {
          ok: false,
          count,
          brokenAt: r.id,
          reason: `Chain link broken before reading #${r.id} (a reading was deleted or reordered)`,
        };
      }
      if (chainHash(keys.chainKey, r.prevHash, r) !== r.hash) {
        return { ok: false, count, brokenAt: r.id, reason: `Reading #${r.id} was modified` };
      }
      expectedPrev = r.hash;
      lastId = r.id;
      count++;
    }
    cursor = batch[batch.length - 1]!.id;
  }

  const meta = await prisma.meta.findUnique({ where: { key: HEAD_KEY } });
  const head = parseHead(meta?.value);
  if (!head) {
    return count === 0
      ? { ok: true, count, lastId }
      : { ok: false, count, brokenAt: lastId, reason: 'Signed chain head is missing' };
  }
  if (!verifyHeadSignature(keys.signingPublicKey, head, head.sig)) {
    return { ok: false, count, brokenAt: head.lastId, reason: 'Chain head signature is invalid' };
  }
  if (head.lastId !== lastId || head.hash !== expectedPrev || head.count !== count) {
    return {
      ok: false,
      count,
      brokenAt: head.lastId,
      reason: `Newest readings were deleted: signed head is reading #${head.lastId} (${head.count} readings) but the chain ends at #${lastId ?? 'none'} (${count})`,
    };
  }
  return { ok: true, count, lastId };
}
