/**
 * `npm run demo` - one command for the whole system:
 *
 *   1. `npm run setup` if this installation was never set up
 *   2. PostgreSQL: already running, or Docker Compose (waits for healthy),
 *      or embedded PostgreSQL 16 kept running by this process
 *   3. migrations (idempotent)
 *   4. syslog collector + API server + virtual device together, with coloured
 *      prefixes; Ctrl+C stops all of them (whole process trees, also on Windows)
 *   5. prints the URLs and where to find the OTP email
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import concurrently from 'concurrently';
import { loadEnv, requireEnv } from '../src/env.js';
import { PATHS } from '../src/paths.js';
import { ensureDatabase } from './database.js';
import { prismaCli } from './lib/prisma-cli.js';
import { runSetup } from './lib/setup.js';
import { lanIPv4Addresses } from './lib/tls.js';

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[90m${s}\x1b[0m`;

function banner(): void {
  const port = process.env.SERVER_PORT ?? '8443';
  const devicePort = process.env.DEVICE_PORT ?? '4000';
  const lan = lanIPv4Addresses()[0];
  const otp = process.env.SMTP_HOST
    ? `sent by email via ${process.env.SMTP_HOST}`
    : `newest ${bold('outbox/email-*.txt')} (no SMTP configured)`;
  const rows: [string, string][] = [
    ['Virtual Garden', bold(`http://localhost:${devicePort}`)],
    [
      'API server',
      `https://localhost:${port}${lan ? dim(`   phone on Wi-Fi: https://${lan}:${port}`) : ''}`,
    ],
    ['Syslog collector', `tls://localhost:${process.env.SYSLOG_PORT ?? '6514'} -> logs/syslog.log`],
    ['Log in', `usernames + passwords in ${bold('CREDENTIALS.txt')}`],
    ['OTP code', otp],
    ['Android emulator', `adb reverse tcp:${port} tcp:${port}  then use https://localhost:${port}`],
    ['Try to break it', 'npm run attack   (in another terminal)'],
    ['Stop', 'Ctrl+C'],
  ];
  const line = '─'.repeat(72);
  console.log(`\n${line}\n ${bold('Secured Soil Moisture Monitoring System - demo')}\n${line}`);
  for (const [k, v] of rows) console.log(`  ${k.padEnd(18)} ${v}`);
  console.log(`${line}\n`);
}

async function main(): Promise<number> {
  // 1. First run: full setup (certificate, keys, database, device, users).
  const needsSetup = [
    PATHS.env,
    PATHS.tlsCert,
    PATHS.masterKey,
    PATHS.deviceConfig,
    PATHS.credentials,
  ].some((f) => !existsSync(f));
  if (needsSetup) {
    console.log(bold('First run - running setup...'));
    await runSetup();
  }
  loadEnv();

  // 2. Database (kept running by this process when embedded).
  console.log(bold('\nStarting PostgreSQL...'));
  const db = await ensureDatabase(requireEnv('DATABASE_URL'));

  // 3. Schema up to date (and the generated client present after a fresh clone).
  if (!existsSync(path.join(PATHS.root, 'server', 'src', 'generated')))
    prismaCli(['generate', '--no-hints'], true);
  prismaCli(['migrate', 'deploy'], true);

  // 4. Everything else, together.
  banner();
  const { result } = concurrently(
    [
      { name: 'syslog', command: 'tsx syslog/src/index.ts', prefixColor: 'magenta' },
      { name: 'server', command: 'tsx server/src/index.ts', prefixColor: 'blue' },
      { name: 'device', command: 'tsx device/src/index.ts', prefixColor: 'green' },
    ],
    {
      cwd: PATHS.root,
      prefix: 'name',
      padPrefix: true,
      killOthersOn: ['failure', 'success'], // one stops -> all stop
      killTimeout: 5000,
    },
  );
  // Show the URLs again once the startup messages have scrolled past.
  const reminder = setTimeout(banner, 8000);

  let code = 0;
  try {
    await result;
  } catch {
    code = 1; // a process failed or Ctrl+C was pressed
  } finally {
    clearTimeout(reminder);
    if (db.mode === 'embedded') console.log('Stopping embedded PostgreSQL...');
    await db.stop();
  }
  return code;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`\n\x1b[31mDemo failed:\x1b[0m ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
