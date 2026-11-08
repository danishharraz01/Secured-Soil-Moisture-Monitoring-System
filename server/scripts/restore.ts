/**
 * `npm run restore [file]` - verify and decrypt an encrypted cloud backup.
 *
 *   1. Ed25519 signature (server public key)
 *   2. unwrap the AES data key with the OFFLINE RSA-3072 private key
 *   3. AES-256-GCM decryption (authentication tag)
 *   4. SHA-256 of the plaintext
 *   5. hash chain links (+ every HMAC when server/keys/chain.key is present)
 *
 * Writes the decrypted data to restored/<file> and prints a summary.
 * Without an argument the newest backup in cloud/ is used.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/env.js';
import { PATHS } from '../src/paths.js';
import { openBackup } from '../src/services/backup.js';
import { out, writeSecretFile } from './lib/files.js';

loadEnv();
const cloudDir = path.resolve(PATHS.root, process.env.CLOUD_DIR || 'cloud');
const arg = process.argv[2];

function newestBackup(): string | undefined {
  if (!existsSync(cloudDir)) return undefined;
  return readdirSync(cloudDir)
    .filter((f) => /^backup-[\w-]+\.json$/.test(f))
    .sort()
    .at(-1);
}

function main(): number {
  console.log('\x1b[1mSecured Soil Moisture Monitoring System - restore backup\x1b[0m');

  const file = arg
    ? path.resolve(process.cwd(), arg)
    : (() => {
        const name = newestBackup();
        return name ? path.join(cloudDir, name) : undefined;
      })();
  if (!file) {
    console.log(`\nNo backup found in ${path.relative(PATHS.root, cloudDir)}/ yet.`);
    console.log('Backups are created every 10 minutes while the server runs,');
    console.log(
      'or immediately: log in as admin in the app -> Settings -> "Back up to cloud now".',
    );
    return 0;
  }
  if (!existsSync(file)) {
    console.error(`\nBackup file not found: ${arg}`);
    return 1;
  }
  if (!existsSync(PATHS.backupPrivateKey)) {
    console.error(
      '\nOffline private key missing: offline-keys/backup-rsa3072.pem - backups cannot be decrypted without it.',
    );
    return 1;
  }

  out.step(`Checking ${path.relative(PATHS.root, file)}`);
  const result = openBackup(readFileSync(file, 'utf8'), {
    signingPublicKey: createPublicKey(readFileSync(PATHS.signingPublicKey, 'utf8')),
    backupPrivateKey: createPrivateKey(readFileSync(PATHS.backupPrivateKey, 'utf8')),
    ...(existsSync(PATHS.chainKey)
      ? { chainKey: Buffer.from(readFileSync(PATHS.chainKey, 'utf8').trim(), 'base64') }
      : {}),
  });
  for (const c of result.checks) {
    if (c.ok) out.done(`${c.name.padEnd(22)} ${c.detail ?? ''}`);
    else console.log(`  \x1b[31m✗ ${c.name.padEnd(22)} ${c.detail ?? ''}\x1b[0m`);
  }
  if (!result.ok) {
    console.error(`\n\x1b[31mRestore refused - ${result.error}\x1b[0m`);
    return 1;
  }

  const p = result.plaintext;
  const target = path.join(PATHS.restoredDir, path.basename(file));
  writeSecretFile(target, `${JSON.stringify(p, null, 2)}\n`);

  out.step('Summary');
  const r = p.readings;
  out.info(`Backup created     ${p.createdAt}`);
  out.info(`Readings           ${r.length}${r.length ? ` (#${r[0]!.id} - #${r.at(-1)!.id})` : ''}`);
  if (r.length) {
    const mm = r.map((x) => x.moistureMm);
    const avg = mm.reduce((a, b) => a + b, 0) / mm.length;
    out.info(`Device time range  ${r[0]!.ts}  ->  ${r.at(-1)!.ts}`);
    out.info(
      `Soil moisture      avg ${avg.toFixed(1)} mm, min ${Math.min(...mm).toFixed(1)}, max ${Math.max(...mm).toFixed(1)}`,
    );
    out.info(`Water pumped       ${r.reduce((a, x) => a + x.waterMl, 0)} ml`);
  }
  out.info(`Chain head         #${p.head?.lastId ?? '-'} ${p.head?.hash.slice(0, 16) ?? ''}…`);
  console.log(`\n\x1b[32m\x1b[1mRestored\x1b[0m -> ${path.relative(PATHS.root, target)}`);
  return 0;
}

process.exitCode = main();
