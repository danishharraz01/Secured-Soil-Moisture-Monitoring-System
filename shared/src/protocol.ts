/**
 * Device <-> server wire protocol, shared so the device, the server, the
 * tests and the attack script all build and check messages the same way.
 *
 * Request (device -> server), POST /api/device/telemetry:
 *   body     = AES-128-GCM envelope of the JSON payload, AAD = device ID
 *   headers  = X-Device-Id, X-Timestamp (ms), X-Nonce (16 random bytes hex),
 *              X-Signature = HMAC-SHA256(macKey, signingString(...))
 *
 * Reply (server -> device), 200:
 *   body     = {deviceId, low, high, nonce, issuedAt}
 *   header   = X-Server-Signature = Ed25519("soil reply v1\n" + body), base64
 */
import { sign, verify, type KeyObject } from 'node:crypto';
import { PROTOCOL, validThresholds } from './constants.js';
import {
  encryptJson,
  hmacSha256Hex,
  randomHex,
  signingString,
  type DeviceKeys,
  type EncryptedEnvelope,
} from './crypto.js';

// ---------------------------------------------------------------------------
// Payloads (plaintext inside the encrypted envelope)
// ---------------------------------------------------------------------------

export interface ReadingPayload {
  type: 'reading';
  moistureMm: number;
  pumpOn: boolean;
  /** Water pumped since the previous reading, in ml. */
  waterMl: number;
  /** Device clock (simulated time in demo mode), ISO 8601. */
  simTime: string;
}

export interface HeartbeatPayload {
  type: 'heartbeat';
  /** Seconds since the device booted. */
  uptime: number;
}

export interface MotionPayload {
  type: 'motion';
  sensor: string;
  simTime: string;
}

export type DevicePayload = ReadingPayload | HeartbeatPayload | MotionPayload;

// ---------------------------------------------------------------------------
// Building a signed, encrypted request
// ---------------------------------------------------------------------------

export interface SignedDeviceRequest {
  path: string;
  body: string;
  headers: Record<string, string>;
  envelope: EncryptedEnvelope;
  timestamp: number;
  nonce: string;
}

export interface BuildRequestOptions {
  deviceId: string;
  keys: DeviceKeys;
  payload: unknown;
  /** Override for tests/attacks; defaults to now. */
  timestamp?: number;
  /** Override for tests/attacks; defaults to 16 fresh random bytes. */
  nonce?: string;
  path?: string;
}

/** Encrypts `payload` and signs the request. A fresh nonce + timestamp is used for every call. */
export function buildDeviceRequest(opts: BuildRequestOptions): SignedDeviceRequest {
  const path = opts.path ?? PROTOCOL.telemetryPath;
  const timestamp = opts.timestamp ?? Date.now();
  const nonce = opts.nonce ?? randomHex(PROTOCOL.nonceBytes);
  const envelope = encryptJson(opts.keys.encKey, opts.payload, opts.deviceId);
  const body = JSON.stringify(envelope);
  const signature = hmacSha256Hex(
    opts.keys.macKey,
    signingString('POST', path, timestamp, nonce, body),
  );
  const h = PROTOCOL.headers;
  return {
    path,
    body,
    envelope,
    timestamp,
    nonce,
    headers: {
      'content-type': 'application/json',
      [h.deviceId]: opts.deviceId,
      [h.timestamp]: String(timestamp),
      [h.nonce]: nonce,
      [h.signature]: signature,
    },
  };
}

// ---------------------------------------------------------------------------
// Server replies (Ed25519)
// ---------------------------------------------------------------------------

export interface ServerReply {
  deviceId: string;
  low: number;
  high: number;
  /** The nonce of the request this reply answers. */
  nonce: string;
  issuedAt: string;
}

/** Domain separation: a reply signature can never be confused with another Ed25519 signature (e.g. backups). */
const REPLY_CONTEXT = 'soil reply v1\n';

/** Server side: Ed25519 signature (base64) over the exact reply body. */
export function signServerReply(privateKey: KeyObject | string, body: string): string {
  return sign(null, Buffer.from(REPLY_CONTEXT + body, 'utf8'), privateKey).toString('base64');
}

export type ReplyCheck = { ok: true; reply: ServerReply } | { ok: false; reason: string };

export interface CheckReplyOptions {
  body: string;
  signature: string | undefined;
  publicKey: KeyObject | string;
  expectedDeviceId: string;
  expectedNonce: string;
}

/**
 * Device side: accept a reply ONLY if it is signed by the server's Ed25519 key,
 * is for this device, echoes this request's nonce (so an old reply cannot be
 * replayed) and carries safe thresholds. Otherwise returns the reason.
 */
export function checkServerReply(opts: CheckReplyOptions): ReplyCheck {
  if (!opts.signature) return { ok: false, reason: 'reply has no server signature' };

  let valid: boolean;
  try {
    valid = verify(
      null,
      Buffer.from(REPLY_CONTEXT + opts.body, 'utf8'),
      opts.publicKey,
      Buffer.from(opts.signature, 'base64'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'server signature is invalid' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.body);
  } catch {
    return { ok: false, reason: 'reply is not valid JSON' };
  }
  const r = parsed as Partial<ServerReply> | null;
  if (
    !r ||
    typeof r.deviceId !== 'string' ||
    typeof r.low !== 'number' ||
    typeof r.high !== 'number' ||
    typeof r.nonce !== 'string' ||
    typeof r.issuedAt !== 'string'
  ) {
    return { ok: false, reason: 'reply has the wrong shape' };
  }
  if (r.deviceId !== opts.expectedDeviceId) {
    return { ok: false, reason: `reply is for another device (${r.deviceId})` };
  }
  if (r.nonce !== opts.expectedNonce) {
    return { ok: false, reason: 'reply does not echo our nonce (possible replay)' };
  }
  if (!validThresholds(r.low, r.high)) {
    return { ok: false, reason: `unsafe thresholds ${r.low} / ${r.high} mm rejected` };
  }
  return { ok: true, reply: r as ServerReply };
}
