/**
 * Helpers for the attack script: talks to the running API server exactly like
 * an outsider would (HTTPS), plus a few "insider" abilities used to simulate
 * conditions (reading OTP emails from outbox/, aging a session in the DB).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { deriveDeviceKeys, type DeviceKeys, type SignedDeviceRequest } from '@soil/shared';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const TARGET = new URL(
  process.env.ATTACK_TARGET ?? `https://localhost:${process.env.SERVER_PORT ?? '8443'}`,
);

function readRequired(rel: string, hint: string): string {
  const file = path.join(ROOT, rel);
  if (!existsSync(file)) throw new Error(`${rel} not found - ${hint}`);
  return readFileSync(file, 'utf8');
}

/** The attacker connects with TLS verification ON, trusting the real server certificate. */
const CA = readRequired('certs/server.crt', 'run "npm run setup" first');

export interface Res {
  status: number;
  text: string;
  json: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

export function request(
  method: string,
  pathname: string,
  opts: { headers?: Record<string, string>; body?: string; token?: string } = {},
): Promise<Res> {
  const headers: Record<string, string | number> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) {
    headers['content-type'] ??= 'application/json';
    headers['content-length'] = Buffer.byteLength(opts.body);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: TARGET.hostname,
        port: TARGET.port,
        path: pathname,
        method,
        ca: CA,
        headers,
        timeout: 10_000,
        agent: false,
      },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString('utf8')));
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, text, json, headers: res.headers });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** Plain HTTP (no TLS) to the HTTPS port - resolves with the status or the error text. */
export function plainHttp(pathname: string): Promise<string> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: TARGET.hostname, port: TARGET.port, path: pathname, timeout: 5_000 },
      (res) => {
        res.resume();
        resolve(`HTTP ${res.statusCode}`);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
    req.end();
  });
}

export function sendDevice(
  req: SignedDeviceRequest,
  override: { headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return request('POST', req.path, {
    headers: { ...req.headers, ...override.headers },
    body: override.body ?? req.body,
  });
}

// ---------------------------------------------------------------------------
// The legitimate device (to show that even a holder of the real key is
// stopped by later checks: replay, encryption required, validation...)
// ---------------------------------------------------------------------------

const deviceFile = JSON.parse(readRequired('device/device.json', 'run "npm run setup" first')) as {
  deviceId: string;
  secret: string;
};
export const DEVICE_ID = deviceFile.deviceId;
export const deviceKeys: DeviceKeys = deriveDeviceKeys(Buffer.from(deviceFile.secret, 'base64'));

// ---------------------------------------------------------------------------
// Users (CREDENTIALS.txt) and OTP codes (outbox/ - only when SMTP is not configured)
// ---------------------------------------------------------------------------

export function password(username: 'admin' | 'viewer'): string {
  const line = readRequired('CREDENTIALS.txt', 'run "npm run setup" first')
    .split('\n')
    .find((l) => l.trimStart().startsWith(`${username} `));
  const pw = line?.trim().split(/\s+/)[1];
  if (!pw) throw new Error(`No password for ${username} in CREDENTIALS.txt`);
  return pw;
}

export const OTP_READABLE = !process.env.SMTP_HOST;
const OUTBOX = path.resolve(ROOT, process.env.OUTBOX_DIR || 'outbox');

/** Waits for a new OTP email (written after `since`) and returns its code. */
export async function waitForOtp(since: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    if (existsSync(OUTBOX)) {
      const fresh = readdirSync(OUTBOX)
        .filter((f) => f.startsWith('email-'))
        .map((f) => path.join(OUTBOX, f))
        .filter((f) => statSync(f).mtimeMs >= since - 5)
        .sort();
      for (const f of fresh.reverse()) {
        const code = /code is: (\d{6})/.exec(readFileSync(f, 'utf8'))?.[1];
        if (code) return code;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('No OTP email appeared in outbox/');
}

/** Password step only. */
export async function startLogin(
  username: 'admin' | 'viewer',
): Promise<{ challengeId: string; code: string }> {
  const since = Date.now();
  const res = await request('POST', '/api/login', {
    body: JSON.stringify({ username, password: password(username) }),
  });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${res.text}`);
  return { challengeId: String(res.json.challengeId), code: await waitForOtp(since) };
}

/** Full Flow 2 login -> session token. */
export async function login(username: 'admin' | 'viewer'): Promise<string> {
  const { challengeId, code } = await startLogin(username);
  const res = await request('POST', '/api/login/otp', {
    body: JSON.stringify({ challengeId, code }),
  });
  if (res.status !== 200) throw new Error(`otp ${username} failed: ${res.status} ${res.text}`);
  return String(res.json.token);
}
