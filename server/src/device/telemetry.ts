/**
 * POST /api/device/telemetry - the only way a device talks to the server.
 *
 * Checks run IN THIS ORDER; the first failure rejects the request and is
 * written to the audit log + syslog WARNING with the reason:
 *
 *   1. device ID format + device exists                 400 / 401
 *   2. timestamp within +-30 s of server time            401
 *   3. nonce format (16 bytes hex)                       400
 *   4. HMAC-SHA256 signature (constant-time compare)     401
 *   5. nonce not used before (stored, 10 min TTL)        409 replay
 *   6. body is an encrypted envelope (not plain JSON)    400
 *   7. AES-128-GCM decryption (auth tag, AAD = device)   400
 *   8. zod validation per payload type                   422
 *   9. handle -> reply signed with Ed25519
 *
 * Cheap checks come first, the signature is verified before anything is
 * stored, and the nonce is only recorded for authentic requests (so an
 * attacker cannot burn nonces). The body limit is 2 KB.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  decryptJson,
  DEVICE_ID_PATTERN,
  deriveDeviceKeys,
  isEncryptedEnvelope,
  NONCE_PATTERN,
  PROTOCOL,
  SIGNATURE_PATTERN,
  signingString,
  signServerReply,
  verifyHmacHex,
  type DeviceKeys,
} from '@soil/shared';
import type { AppContext } from '../context.js';
import { isUniqueViolation, type Device } from '../db.js';
import { decryptDeviceSecret } from '../security/keys.js';
import { handleHeartbeat, handleMotion, handleReading } from './handlers.js';
import { describeIssue, devicePayloadSchema } from './schemas.js';

/** A rejection: HTTP status, short reason code (logged) and client-facing message. */
class Reject extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly actor = 'unknown',
  ) {
    super(message);
  }
}

/** Decrypted device keys, cached until the stored secret changes. */
const keyCache = new Map<string, { secretEnc: string; keys: DeviceKeys }>();

function deviceKeys(ctx: AppContext, device: Device): DeviceKeys {
  const cached = keyCache.get(device.id);
  if (cached?.secretEnc === device.secretEnc) return cached.keys;
  const keys = deriveDeviceKeys(
    decryptDeviceSecret(ctx.keys.masterKey, device.id, device.secretEnc),
  );
  keyCache.set(device.id, { secretEnc: device.secretEnc, keys });
  return keys;
}

async function verifyAndDecrypt(
  ctx: AppContext,
  req: Request,
): Promise<{ device: Device; payload: unknown; nonce: string }> {
  const header = (name: string): string | undefined => req.get(name) ?? undefined;
  const H = PROTOCOL.headers;

  // 1. Device ID format + exists. The regex stops SQL/script injection before any lookup
  //    (and Prisma parameterises queries anyway).
  const deviceId = header(H.deviceId);
  if (!deviceId || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Reject(400, 'invalid_device_id', 'Invalid device ID');
  }
  const device = await ctx.prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) throw new Reject(401, 'unknown_device', 'Unknown device');

  // 2. Timestamp within +-30 s.
  const tsText = header(H.timestamp) ?? '';
  if (!/^\d{13}$/.test(tsText))
    throw new Reject(401, 'bad_timestamp', 'Missing or invalid timestamp', device.id);
  if (Math.abs(Date.now() - Number(tsText)) > PROTOCOL.timestampSkewMs) {
    throw new Reject(
      401,
      'stale_timestamp',
      'Request timestamp is outside the allowed 30 s window',
      device.id,
    );
  }

  // 3. Nonce format.
  const nonce = header(H.nonce) ?? '';
  if (!NONCE_PATTERN.test(nonce))
    throw new Reject(400, 'bad_nonce', 'Missing or invalid nonce', device.id);

  // 4. HMAC signature over METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(BODY), constant-time compare.
  const signature = (header(H.signature) ?? '').toLowerCase();
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new Reject(401, 'missing_signature', 'Missing or malformed signature', device.id);
  }
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const keys = deviceKeys(ctx, device);
  const toSign = signingString('POST', PROTOCOL.telemetryPath, tsText, nonce, body);
  if (!verifyHmacHex(keys.macKey, toSign, signature)) {
    throw new Reject(401, 'bad_signature', 'Invalid signature', device.id);
  }

  // 5. Nonce never seen before (primary key deviceId+nonce makes this atomic).
  try {
    await ctx.prisma.nonce.create({ data: { deviceId: device.id, nonce } });
  } catch (e) {
    if (isUniqueViolation(e))
      throw new Reject(409, 'replay', 'Replay detected: nonce already used', device.id);
    throw e;
  }

  // 6. Must be the encrypted envelope - a correctly signed PLAIN payload is still refused.
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    parsed = undefined;
  }
  if (!isEncryptedEnvelope(parsed)) {
    throw new Reject(400, 'unencrypted_payload', 'Payload must be encrypted', device.id);
  }

  // 7. AES-128-GCM decrypt; the device ID is the AAD.
  let payload: unknown;
  try {
    payload = decryptJson(keys.encKey, parsed, device.id);
  } catch {
    throw new Reject(
      400,
      'decrypt_failed',
      'Decryption failed (payload modified or wrong key)',
      device.id,
    );
  }
  return { device, payload, nonce };
}

export function telemetryRouter(ctx: AppContext): express.Router {
  const router = express.Router();

  const reject = async (req: Request, res: Response, r: Reject): Promise<void> => {
    await ctx.audit.record({
      actor: r.actor,
      action: 'device_rejected',
      detail: `${r.code}: ${r.message}`,
      ip: req.ip,
      msgId: 'device',
      data: { reason: r.code, status: r.status },
    });
    res.status(r.status).json({ error: r.message });
  };

  router.post(
    '/telemetry',
    // Raw bytes: the HMAC covers the exact body. Anything above 2 KB -> 413.
    express.raw({ type: () => true, limit: PROTOCOL.maxBodyBytes }),
    async (req: Request, res: Response) => {
      let verified: Awaited<ReturnType<typeof verifyAndDecrypt>>;
      try {
        verified = await verifyAndDecrypt(ctx, req);
      } catch (e) {
        if (e instanceof Reject) return reject(req, res, e);
        throw e;
      }
      const { device, payload, nonce } = verified;
      const ip = req.ip ?? '';

      // 8. Validate the decrypted payload.
      const parsed = devicePayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return reject(
          req,
          res,
          new Reject(
            422,
            'invalid_payload',
            `Invalid payload (${describeIssue(parsed.error)})`,
            device.id,
          ),
        );
      }

      // 9. Handle.
      const p = parsed.data;
      if (p.type === 'reading') await handleReading(ctx, device, p, ip);
      else if (p.type === 'motion') await handleMotion(ctx, device, p);
      else await handleHeartbeat(ctx, device, ip);

      // Signed reply: current thresholds, echoing the request nonce (the device
      // only applies thresholds from a reply bound to its own request).
      const fresh = await ctx.prisma.device.findUniqueOrThrow({ where: { id: device.id } });
      const reply = JSON.stringify({
        deviceId: device.id,
        low: fresh.low,
        high: fresh.high,
        nonce,
        issuedAt: new Date().toISOString(),
      });
      res
        .status(200)
        .type('application/json')
        .set(PROTOCOL.headers.serverSignature, signServerReply(ctx.keys.signingPrivateKey, reply))
        .send(reply);
    },
  );

  // Oversized or unreadable bodies are rejected (and audited) like any other bad request.
  router.use(async (err: unknown, req: Request, res: Response, next: NextFunction) => {
    const e = err as { type?: string; status?: number };
    if (e.type === 'entity.too.large') {
      const actor = DEVICE_ID_PATTERN.test(req.get(PROTOCOL.headers.deviceId) ?? '')
        ? req.get(PROTOCOL.headers.deviceId)!
        : 'unknown';
      return reject(
        req,
        res,
        new Reject(
          413,
          'payload_too_large',
          `Payload too large (max ${PROTOCOL.maxBodyBytes} bytes)`,
          actor,
        ),
      );
    }
    next(err);
  });

  return router;
}
