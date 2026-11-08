/**
 * `npm run attack [-- --tamper-db]` - red-team script against the RUNNING system.
 *
 * Every attack prints BLOCKED (the defence worked) or NOT BLOCKED, followed by
 * a final count. Expected result: 0 got through. Exit code 1 otherwise (CI).
 *
 * Brute force runs last because it blocks this IP from logging in for 5 minutes.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  buildDeviceRequest,
  deriveDeviceKeys,
  hmacSha256Hex,
  PROTOCOL,
  randomHex,
  sha256Hex,
  signingString,
} from '@soil/shared';
import {
  DEVICE_ID,
  deviceKeys,
  login,
  OTP_READABLE,
  plainHttp,
  request,
  sendDevice,
  startLogin,
  TARGET,
} from './lib.js';

const TAMPER_DB = process.argv.includes('--tamper-db');
const color = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code: string, s: string): string => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

type Outcome = { blocked: boolean; detail: string } | { skipped: string };
interface Attack {
  name: string;
  run: () => Promise<Outcome>;
}

const heartbeat = () => ({ type: 'heartbeat', uptime: 42 });
const attackerKeys = deriveDeviceKeys(randomBytes(32));
/** BLOCKED when the status matches; the detail shows what the server said. */
const expect = (
  status: number,
  res: { status: number; json: Record<string, unknown> },
  extra = '',
): Outcome => ({
  blocked: res.status === status,
  detail:
    `HTTP ${res.status} ${typeof res.json.error === 'string' ? res.json.error : ''}${extra}`.trim(),
});

// Tokens are created lazily (after the device attacks) and shared.
let adminToken: string | undefined;
let viewerToken: string | undefined;
const needOtp = (): Outcome | undefined =>
  OTP_READABLE
    ? undefined
    : { skipped: 'SMTP is configured - OTP codes are not readable from outbox/' };

const db = (): pg.Client => new pg.Client({ connectionString: process.env.DATABASE_URL });

const attacks: Attack[] = [
  // ---------------------------------------------------------------- transport
  {
    name: 'Plain HTTP (no TLS) to the API port',
    run: async () => {
      const r = await plainHttp('/api/health');
      return { blocked: !r.startsWith('HTTP 2'), detail: `${r} - the server only speaks TLS 1.2+` };
    },
  },
  {
    name: 'Eavesdropper on the network sees only ciphertext',
    run: () => {
      const req = buildDeviceRequest({
        deviceId: DEVICE_ID,
        keys: deviceKeys,
        payload: {
          type: 'reading',
          moistureMm: 27.31,
          pumpOn: false,
          waterMl: 0,
          simTime: new Date().toISOString(),
        },
      });
      const leaked = ['moistureMm', '27.31', 'reading', 'pumpOn'].filter((s) =>
        req.body.includes(s),
      );
      return Promise.resolve({
        blocked: leaked.length === 0,
        detail: leaked.length
          ? `plaintext visible: ${leaked.join(', ')}`
          : `body is ${req.body.slice(0, 60)}… (AES-128-GCM, inside TLS)`,
      });
    },
  },
  // ------------------------------------------------------------ device channel
  {
    name: 'Device message without a signature',
    run: async () =>
      expect(
        401,
        await sendDevice(
          buildDeviceRequest({ deviceId: DEVICE_ID, keys: deviceKeys, payload: heartbeat() }),
          { headers: { 'x-signature': '' } },
        ),
      ),
  },
  {
    name: 'Device message signed with a wrong key',
    run: async () =>
      expect(
        401,
        await sendDevice(
          buildDeviceRequest({ deviceId: DEVICE_ID, keys: attackerKeys, payload: heartbeat() }),
        ),
      ),
  },
  {
    name: 'Ciphertext modified in transit',
    run: async () => {
      const req = buildDeviceRequest({
        deviceId: DEVICE_ID,
        keys: deviceKeys,
        payload: heartbeat(),
      });
      const env = JSON.parse(req.body) as { ct: string };
      const ct = Buffer.from(env.ct, 'base64');
      ct[0] = (ct[0] ?? 0) ^ 0xff;
      return expect(
        401,
        await sendDevice(req, { body: JSON.stringify({ ...env, ct: ct.toString('base64') }) }),
      );
    },
  },
  {
    name: 'Unencrypted payload with a VALID signature',
    run: async () => {
      const body = JSON.stringify(heartbeat());
      const ts = Date.now();
      const nonce = randomHex(16);
      const sig = hmacSha256Hex(
        deviceKeys.macKey,
        signingString('POST', PROTOCOL.telemetryPath, ts, nonce, body),
      );
      const res = await request('POST', PROTOCOL.telemetryPath, {
        headers: {
          'x-device-id': DEVICE_ID,
          'x-timestamp': String(ts),
          'x-nonce': nonce,
          'x-signature': sig,
        },
        body,
      });
      return expect(400, res);
    },
  },
  {
    name: 'Replay of a captured valid request',
    run: async () => {
      const req = buildDeviceRequest({
        deviceId: DEVICE_ID,
        keys: deviceKeys,
        payload: heartbeat(),
      });
      const first = await sendDevice(req);
      const replay = await sendDevice(req);
      return expect(409, replay, ` (original: HTTP ${first.status})`);
    },
  },
  {
    name: 'Valid request sent 5 minutes later',
    run: async () =>
      expect(
        401,
        await sendDevice(
          buildDeviceRequest({
            deviceId: DEVICE_ID,
            keys: deviceKeys,
            payload: heartbeat(),
            timestamp: Date.now() - 5 * 60_000,
          }),
        ),
      ),
  },
  {
    name: "SQL injection in the device ID (celery' OR '1'='1)",
    run: async () =>
      expect(
        400,
        await sendDevice(
          buildDeviceRequest({ deviceId: DEVICE_ID, keys: deviceKeys, payload: heartbeat() }),
          { headers: { 'x-device-id': "celery-node-01' OR '1'='1" } },
        ),
      ),
  },
  {
    name: 'Moisture 450 mm (validly signed and encrypted)',
    run: async () =>
      expect(
        422,
        await sendDevice(
          buildDeviceRequest({
            deviceId: DEVICE_ID,
            keys: deviceKeys,
            payload: {
              type: 'reading',
              moistureMm: 450,
              pumpOn: false,
              waterMl: 0,
              simTime: new Date().toISOString(),
            },
          }),
        ),
      ),
  },
  {
    name: 'Fake motion alert (attacker has no device key)',
    run: async () =>
      expect(
        401,
        await sendDevice(
          buildDeviceRequest({
            deviceId: DEVICE_ID,
            keys: attackerKeys,
            payload: { type: 'motion', sensor: 'pir-1', simTime: new Date().toISOString() },
          }),
        ),
      ),
  },
  {
    name: 'Fake heartbeat to hide a disconnected device',
    run: async () =>
      expect(
        401,
        await sendDevice(
          buildDeviceRequest({ deviceId: DEVICE_ID, keys: attackerKeys, payload: heartbeat() }),
        ),
      ),
  },
  {
    name: '5 KB payload',
    run: async () =>
      expect(
        413,
        await sendDevice(
          buildDeviceRequest({
            deviceId: DEVICE_ID,
            keys: deviceKeys,
            payload: { ...heartbeat(), pad: 'x'.repeat(5000) },
          }),
        ),
      ),
  },
  // ------------------------------------------------------------------ app / users
  {
    name: 'Read data without logging in',
    run: async () => expect(401, await request('GET', '/api/readings')),
  },
  {
    name: 'Reuse an OTP that was already used',
    run: async () => {
      const skip = needOtp();
      if (skip) return skip;
      const { challengeId, code } = await startLogin('admin');
      const body = JSON.stringify({ challengeId, code });
      const first = await request('POST', '/api/login/otp', { body });
      adminToken = String(first.json.token);
      const reuse = await request('POST', '/api/login/otp', { body });
      return expect(401, reuse, reuse.json.restart ? ' -> back to login' : '');
    },
  },
  {
    name: 'Wrong OTP (then the right one) -> back to login',
    run: async () => {
      const skip = needOtp();
      if (skip) return skip;
      const { challengeId, code } = await startLogin('viewer');
      const wrongCode = code === '000000' ? '111111' : '000000';
      const wrong = await request('POST', '/api/login/otp', {
        body: JSON.stringify({ challengeId, code: wrongCode }),
      });
      const right = await request('POST', '/api/login/otp', {
        body: JSON.stringify({ challengeId, code }),
      });
      return {
        blocked: wrong.status === 401 && wrong.json.restart === true && right.status === 401,
        detail: `wrong: HTTP ${wrong.status} restart=${String(wrong.json.restart)}; correct code afterwards: HTTP ${right.status} (challenge invalidated)`,
      };
    },
  },
  {
    name: 'Viewer changes the watering thresholds',
    run: async () => {
      const skip = needOtp();
      if (skip) return skip;
      viewerToken ??= await login('viewer');
      return expect(
        403,
        await request('PUT', '/api/config', {
          token: viewerToken,
          body: JSON.stringify({ low: 10, high: 45 }),
        }),
      );
    },
  },
  {
    name: 'Viewer triggers a cloud backup',
    run: async () => {
      const skip = needOtp();
      if (skip) return skip;
      viewerToken ??= await login('viewer');
      return expect(403, await request('POST', '/api/backup', { token: viewerToken }));
    },
  },
  {
    name: 'Expired session token (10-minute limit)',
    run: async () => {
      const skip = needOtp();
      if (skip) return skip;
      const token = await login('admin');
      // Simulate the 10 minutes passing: move this session's expiry into the past.
      const client = db();
      await client.connect();
      try {
        // The column is TIMESTAMP WITHOUT TIME ZONE holding UTC (Prisma convention),
        // so "now" must be taken in UTC - plain now() would use the DB's local zone.
        const aged = await client.query(
          `UPDATE "Session" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE "tokenHash" = $1`,
          [sha256Hex(token)],
        );
        if (aged.rowCount !== 1) return { skipped: 'could not age the session in the database' };
      } finally {
        await client.end();
      }
      const res = await request('GET', '/api/readings', { token });
      return expect(401, res, ` (reason: ${String(res.json.reason)})`);
    },
  },
];

if (TAMPER_DB) {
  attacks.push({
    name: 'Edit a reading directly in PostgreSQL (--tamper-db)',
    run: async () => {
      const skip = needOtp();
      if (skip) return skip;
      adminToken ??= await login('admin');
      const client = db();
      await client.connect();
      try {
        // Make sure there is something to tamper with (fresh installs / CI).
        let { rows } = await client.query<{ id: number; moistureMm: number }>(
          'SELECT id, "moistureMm" FROM "Reading" ORDER BY id DESC LIMIT 3',
        );
        for (let i = rows.length; i < 3; i++) {
          await sendDevice(
            buildDeviceRequest({
              deviceId: DEVICE_ID,
              keys: deviceKeys,
              payload: {
                type: 'reading',
                moistureMm: 28,
                pumpOn: false,
                waterMl: 0,
                simTime: new Date().toISOString(),
              },
            }),
          );
        }
        ({ rows } = await client.query<{ id: number; moistureMm: number }>(
          'SELECT id, "moistureMm" FROM "Reading" ORDER BY id DESC LIMIT 3',
        ));
        const target = rows[rows.length - 1]!;
        const before = await request('GET', '/api/verify', { token: adminToken });

        await client.query('UPDATE "Reading" SET "moistureMm" = 49.9 WHERE id = $1', [target.id]);
        const after = await request('GET', '/api/verify', { token: adminToken });
        // Put the original value back so the demo database stays valid.
        await client.query('UPDATE "Reading" SET "moistureMm" = $1 WHERE id = $2', [
          target.moistureMm,
          target.id,
        ]);
        const restored = await request('GET', '/api/verify', { token: adminToken });

        return {
          blocked: after.json.ok === false && Number(after.json.brokenAt) === target.id,
          detail:
            `before: ok=${String(before.json.ok)}; reading #${target.id} set to 49.9 mm -> /api/verify: ` +
            `"${String(after.json.reason)}"; value restored -> ok=${String(restored.json.ok)}`,
        };
      } finally {
        await client.end();
      }
    },
  });
}

attacks.push({
  name: 'Brute-force the admin password',
  run: async () => {
    for (let i = 1; i <= 10; i++) {
      const res = await request('POST', '/api/login', {
        body: JSON.stringify({ username: 'admin', password: `guess-${i}-${randomHex(3)}` }),
      });
      if (res.status === 429)
        return {
          blocked: true,
          detail: `locked out after ${i - 1} wrong passwords: HTTP 429, Retry-After ${String(res.headers['retry-after'])} s`,
        };
      if (res.status === 200) return { blocked: false, detail: `guess ${i} was accepted!` };
    }
    return { blocked: false, detail: '10 guesses without being blocked' };
  },
});

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log(c('1', `Attacking ${TARGET.origin}${TAMPER_DB ? '  (with --tamper-db)' : ''}\n`));
  const health = await request('GET', '/api/health').catch((e: Error) => e);
  if (health instanceof Error) {
    console.error(
      `Server not reachable at ${TARGET.origin} (${health.message}) - start it with "npm run server"`,
    );
    return 2;
  }

  let blocked = 0;
  let failed = 0;
  let skipped = 0;
  for (const [i, attack] of attacks.entries()) {
    let outcome: Outcome;
    try {
      outcome = await attack.run();
    } catch (e) {
      outcome = {
        blocked: false,
        detail: `attack crashed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const n = String(i + 1).padStart(2);
    if ('skipped' in outcome) {
      skipped++;
      console.log(
        `${n}. ${c('90', 'SKIPPED    ')} ${attack.name}\n    ${c('90', outcome.skipped)}`,
      );
    } else if (outcome.blocked) {
      blocked++;
      console.log(`${n}. ${c('32', 'BLOCKED    ')} ${attack.name}\n    ${c('90', outcome.detail)}`);
    } else {
      failed++;
      console.log(
        `${n}. ${c('1;31', 'NOT BLOCKED')} ${attack.name}\n    ${c('31', outcome.detail)}`,
      );
    }
  }

  const total = blocked + failed;
  console.log(
    `\n${c('1', `${total} attacks: ${blocked} blocked, ${failed} got through`)}${skipped ? `, ${skipped} skipped` : ''}` +
      `  ${failed === 0 ? c('1;32', '✔ 0 got through') : c('1;31', '✘ SECURITY FAILURE')}`,
  );
  console.log(
    c(
      '90',
      'Note: this IP is now locked out of /api/login for 5 minutes (brute-force protection).',
    ),
  );
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main();
