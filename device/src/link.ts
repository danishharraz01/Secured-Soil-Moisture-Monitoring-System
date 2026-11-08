/**
 * The device's network link to the server: HTTPS with the server certificate
 * PINNED. `ca` replaces the system root store, so the device trusts exactly
 * one certificate - a man-in-the-middle with any other certificate (even one
 * from a public CA) is refused. TLS verification is never disabled.
 */
import https from 'node:https';
import type { KeyObject } from 'node:crypto';
import {
  buildDeviceRequest,
  checkServerReply,
  PROTOCOL,
  type DeviceKeys,
  type DevicePayload,
} from '@soil/shared';

export interface LinkOptions {
  deviceId: string;
  keys: DeviceKeys;
  serverUrl: URL;
  serverCertPem: string;
  serverPublicKey: KeyObject;
  timeoutMs?: number;
}

export interface SendResult {
  /** Server accepted the message (HTTP 2xx). */
  ok: boolean;
  status?: number;
  /** Network/TLS error or the server's error message. */
  error?: string;
  /** Worth retrying later (network error or 5xx). 4xx = rejected, do not retry. */
  retry: boolean;
  /** Thresholds from a reply that passed every check. */
  thresholds?: { low: number; high: number };
  /** Why a 200 reply was NOT trusted (thresholds ignored). */
  replyProblem?: string;
  /** First characters of the ciphertext - what an eavesdropper would see. */
  ciphertextPreview: string;
  latencyMs: number;
}

const MAX_REPLY_BYTES = 8 * 1024;

export class ServerLink {
  private readonly agent: https.Agent;
  private readonly timeoutMs: number;

  constructor(private readonly opts: LinkOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.agent = new https.Agent({
      ca: opts.serverCertPem, // pinning: the only trusted certificate
      minVersion: 'TLSv1.2',
      keepAlive: true,
      maxSockets: 2,
    });
  }

  /** Encrypts, signs and sends one payload. Never throws. */
  async send(payload: DevicePayload): Promise<SendResult> {
    const req = buildDeviceRequest({
      deviceId: this.opts.deviceId,
      keys: this.opts.keys,
      payload,
    });
    const started = Date.now();
    const base = { ciphertextPreview: req.envelope.ct.slice(0, 16) + '…' };

    let res: { status: number; body: string; signature: string | undefined };
    try {
      res = await this.post(req.path, req.body, req.headers);
    } catch (e) {
      return {
        ...base,
        ok: false,
        retry: true,
        error: describeNetworkError(e),
        latencyMs: Date.now() - started,
      };
    }
    const latencyMs = Date.now() - started;

    if (res.status < 200 || res.status >= 300) {
      return {
        ...base,
        ok: false,
        status: res.status,
        retry: res.status >= 500,
        error: serverErrorMessage(res.body) ?? `HTTP ${res.status}`,
        latencyMs,
      };
    }

    // Accepted. Only trust thresholds from a correctly signed reply to THIS request.
    const check = checkServerReply({
      body: res.body,
      signature: res.signature,
      publicKey: this.opts.serverPublicKey,
      expectedDeviceId: this.opts.deviceId,
      expectedNonce: req.nonce,
    });
    return check.ok
      ? {
          ...base,
          ok: true,
          status: res.status,
          retry: false,
          latencyMs,
          thresholds: { low: check.reply.low, high: check.reply.high },
        }
      : {
          ...base,
          ok: true,
          status: res.status,
          retry: false,
          latencyMs,
          replyProblem: check.reason,
        };
  }

  close(): void {
    this.agent.destroy();
  }

  private post(
    path: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string; signature: string | undefined }> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.opts.serverUrl);
      const request = https.request(
        url,
        {
          method: 'POST',
          agent: this.agent,
          headers: { ...headers, 'content-length': Buffer.byteLength(body) },
          timeout: this.timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_REPLY_BYTES) {
              request.destroy(new Error('reply too large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const sig = response.headers[PROTOCOL.headers.serverSignature];
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              signature: Array.isArray(sig) ? sig[0] : sig,
            });
          });
          response.on('error', reject);
        },
      );
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', reject);
      request.end(body);
    });
  }
}

function serverErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/** Short, human readable network/TLS error (shown in the event log). */
export function describeNetworkError(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  switch (err.code) {
    case 'ECONNREFUSED':
      return 'server unreachable (connection refused)';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'server host not found';
    case 'ECONNRESET':
      return 'connection reset';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'CERT_SIGNATURE_FAILURE':
      return 'TLS: server certificate is not the pinned one - refused';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'TLS: certificate does not match the server name - refused';
    default:
      return err.message === 'timeout' ? 'server timed out' : (err.message ?? 'network error');
  }
}
