/**
 * The device's pinned HTTPS link against a mock server that performs the same
 * checks the real server will (Phase 3): HMAC signature over the signing
 * string, then AES-128-GCM decryption with the device ID as AAD.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  decryptJson,
  deriveDeviceKeys,
  PROTOCOL,
  signingString,
  signServerReply,
  verifyHmacHex,
  type DevicePayload,
} from '@soil/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTlsCertificate } from '../../server/scripts/lib/tls.js';
import { ServerLink } from '../src/link.js';

const DEVICE_ID = 'celery-node-01';
const keys = deriveDeviceKeys(randomBytes(32));
const serverKeys = generateKeyPairSync('ed25519');
const attackerKeys = generateKeyPairSync('ed25519');

/** How the mock server should reply to the next request. */
let replyMode: 'good' | 'forged' | 'wrong-nonce' | 'unsafe' | 'error500' = 'good';
const received: DevicePayload[] = [];

let server: https.Server;
let url: URL;
let certPem: string;
let otherCertPem: string;

beforeAll(async () => {
  const tls = await generateTlsCertificate({ dns: ['localhost'], ips: ['127.0.0.1'] });
  certPem = tls.certPem;
  otherCertPem = (await generateTlsCertificate({ dns: ['localhost'], ips: ['127.0.0.1'] })).certPem;

  server = https.createServer({ cert: tls.certPem, key: tls.keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const h = (name: string): string => String(req.headers[name] ?? '');
      const toSign = signingString('POST', req.url ?? '', h('x-timestamp'), h('x-nonce'), body);
      if (!verifyHmacHex(keys.macKey, toSign, h('x-signature'))) {
        res.writeHead(401).end(JSON.stringify({ error: 'bad signature' }));
        return;
      }
      received.push(decryptJson(keys.encKey, JSON.parse(body), h('x-device-id')) as DevicePayload);

      if (replyMode === 'error500') {
        res.writeHead(500).end(JSON.stringify({ error: 'database down' }));
        return;
      }
      const reply = JSON.stringify({
        deviceId: DEVICE_ID,
        low: replyMode === 'unsafe' ? 2 : 20,
        high: replyMode === 'unsafe' ? 49 : 30,
        nonce: replyMode === 'wrong-nonce' ? 'f'.repeat(32) : h('x-nonce'),
        issuedAt: new Date().toISOString(),
      });
      const key = replyMode === 'forged' ? attackerKeys.privateKey : serverKeys.privateKey;
      res
        .writeHead(200, {
          'content-type': 'application/json',
          [PROTOCOL.headers.serverSignature]: signServerReply(key, reply),
        })
        .end(reply);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = new URL(`https://localhost:${(server.address() as AddressInfo).port}`);
});

afterAll(() => {
  server.close();
});

function link(pinned = certPem, serverUrl = url): ServerLink {
  return new ServerLink({
    deviceId: DEVICE_ID,
    keys,
    serverUrl,
    serverCertPem: pinned,
    serverPublicKey: serverKeys.publicKey,
    timeoutMs: 2_000,
  });
}

const reading: DevicePayload = {
  type: 'reading',
  moistureMm: 24.31,
  pumpOn: true,
  waterMl: 45,
  simTime: new Date().toISOString(),
};

describe('ServerLink (pinned HTTPS, encrypted + signed)', () => {
  it('delivers an encrypted, signed reading the server can verify and decrypt', async () => {
    replyMode = 'good';
    const l = link();
    const r = await l.send(reading);
    l.close();
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(received.at(-1)).toEqual(reading);
    expect(r.ciphertextPreview).not.toContain('24.31');
  });

  it('accepts thresholds only from a signed reply that echoes the nonce', async () => {
    replyMode = 'good';
    const l = link();
    const r = await l.send({ type: 'heartbeat', uptime: 5 });
    l.close();
    expect(r.thresholds).toEqual({ low: 20, high: 30 });
    expect(r.replyProblem).toBeUndefined();
  });

  it.each([
    ['forged', /signature is invalid/],
    ['wrong-nonce', /does not echo our nonce/],
    ['unsafe', /unsafe thresholds/],
  ] as const)('ignores a %s reply and says why', async (mode, reason) => {
    replyMode = mode;
    const l = link();
    const r = await l.send({ type: 'heartbeat', uptime: 5 });
    l.close();
    expect(r.ok).toBe(true); // the message itself was delivered...
    expect(r.thresholds).toBeUndefined(); // ...but the thresholds were NOT applied
    expect(r.replyProblem).toMatch(reason);
  });

  it('refuses a server whose certificate is not the pinned one (MITM)', async () => {
    const l = link(otherCertPem);
    const r = await l.send(reading);
    l.close();
    expect(r.ok).toBe(false);
    expect(r.retry).toBe(true);
    expect(r.error).toMatch(/TLS/);
  });

  it('reports 5xx as retryable', async () => {
    replyMode = 'error500';
    const l = link();
    const r = await l.send(reading);
    l.close();
    expect(r).toMatchObject({ ok: false, status: 500, retry: true, error: 'database down' });
  });

  it('reports an unreachable server as retryable', async () => {
    const l = link(certPem, new URL('https://localhost:1'));
    const r = await l.send(reading);
    l.close();
    expect(r).toMatchObject({
      ok: false,
      retry: true,
      error: 'server unreachable (connection refused)',
    });
  });
});
