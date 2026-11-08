/**
 * `npm run reset` - WIPES all data, keys, certificates and credentials, then
 * runs setup again. .env (and the embedded database cluster's password) is kept.
 *
 * Asks for confirmation; pass `--yes` to skip it (e.g. in scripts).
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadEnv, requireEnv } from '../src/env.js';
import { PATHS } from '../src/paths.js';
import { ensureDatabase } from './database.js';
import { out } from './lib/files.js';
import { runSetup } from './lib/setup.js';

const WIPE = [
  PATHS.certsDir,
  PATHS.serverKeysDir,
  PATHS.offlineKeysDir,
  PATHS.deviceConfig,
  PATHS.credentials,
  PATHS.appCert,
  PATHS.outboxDir,
  PATHS.logsDir,
  PATHS.cloudDir,
  PATHS.restoredDir,
];

async function confirm(): Promise<boolean> {
  if (process.argv.includes('--yes')) return true;
  if (!process.stdin.isTTY) {
    console.error('Refusing to reset without confirmation. Run: npm run reset -- --yes');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    '\x1b[33mThis deletes ALL readings, users, keys, certificates and backups.\x1b[0m Type RESET to continue: ',
  );
  rl.close();
  return answer.trim() === 'RESET';
}

async function wipeDatabase(): Promise<void> {
  out.step('Wiping database');
  const db = await ensureDatabase(requireEnv('DATABASE_URL'), out.info);
  try {
    const { createPrisma } = await import('../src/db.js');
    const prisma = createPrisma();
    try {
      // Fixed SQL, no user input. Drops every table incl. Prisma's migration history.
      await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
      await prisma.$executeRawUnsafe('CREATE SCHEMA public');
      out.done('schema "public" dropped and recreated');
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    await db.stop();
  }
}

function wipeFiles(): void {
  out.step('Wiping generated files');
  for (const target of WIPE) {
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    out.done(path.relative(PATHS.root, target));
  }
}

try {
  if (!(await confirm())) {
    console.log('Reset cancelled.');
    process.exitCode = 1;
  } else {
    loadEnv();
    // The generated Prisma client is needed to wipe; it exists if setup ever ran.
    if (existsSync(PATHS.env) && existsSync(path.join(PATHS.root, 'server', 'src', 'generated'))) {
      await wipeDatabase();
    }
    wipeFiles();
    await runSetup();
  }
} catch (e) {
  console.error(`\n\x1b[31mReset failed:\x1b[0m ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
