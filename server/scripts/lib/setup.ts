/**
 * `npm run setup` - prepares everything the system needs. IDEMPOTENT: every
 * step checks what already exists and only creates what is missing, so it is
 * safe to run again at any time. `npm run reset` wipes everything first.
 *
 * Secrets are written to files only - never printed to the console.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { MOISTURE, randomHex } from '@soil/shared';
import type { PrismaClient } from '../../src/db.js';
import { loadEnv, requireEnv } from '../../src/env.js';
import { PATHS } from '../../src/paths.js';
import { hashPassword, generatePassword } from '../../src/security/password.js';
import {
  decryptDeviceSecret,
  encryptDeviceSecret,
  generateEd25519Pem,
  generateRsa3072Pem,
  generateSymmetricKeyFile,
  loadServerKeys,
  type ServerKeys,
} from '../../src/security/keys.js';
import { defaultSans, generateTlsCertificate, lanIPv4Addresses, missingSans } from './tls.js';
import { ensureDatabase } from '../database.js';
import { out, writePublicFile, writeSecretFile } from './files.js';
import { prismaCli } from './prisma-cli.js';

export const DEVICE_ID = 'celery-node-01';
const ENV_PLACEHOLDER = 'change-me-local-dev-only';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/** Contents of device/device.json - everything the virtual NodeMCU needs. */
export interface DeviceFile {
  deviceId: string;
  /** 256-bit device secret, base64. Encryption and MAC keys are derived from it with HKDF. */
  secret: string;
  serverUrl: string;
  /** Pinned server certificate (path relative to the device/ folder). */
  serverCertPath: string;
  /** Server Ed25519 public key - replies (new thresholds) must be signed with it. */
  serverSigningPublicKey: string;
  provisionedAt: string;
}

// ---------------------------------------------------------------------------

function ensureEnvFile(): void {
  out.step('Environment (.env)');
  if (existsSync(PATHS.env)) {
    out.skip('.env exists - kept');
    return;
  }
  // Replace the example database password with a random one.
  const content = readFileSync(PATHS.envExample, 'utf8').replaceAll(ENV_PLACEHOLDER, randomHex(18));
  writeSecretFile(PATHS.env, content);
  out.done('.env created from .env.example with a random database password');
}

async function ensureTlsCertificate(): Promise<void> {
  out.step('TLS certificate (ECDSA P-256, self-signed, pinned by device + app)');
  const sans = defaultSans();
  if (existsSync(PATHS.tlsCert) && existsSync(PATHS.tlsKey)) {
    const missing = missingSans(readFileSync(PATHS.tlsCert, 'utf8'), sans);
    if (missing.length === 0) out.skip('certs/server.crt exists and covers all addresses');
    else
      out.warn(
        `certs/server.crt does not cover ${missing.join(', ')} - run "npm run reset" to regenerate`,
      );
    return;
  }
  const { certPem, keyPem } = await generateTlsCertificate(sans);
  writePublicFile(PATHS.tlsCert, certPem);
  writeSecretFile(PATHS.tlsKey, keyPem);
  out.done(`certs/server.crt + server.key  (SAN: ${[...sans.dns, ...sans.ips].join(', ')})`);
}

/** Returns true if a new chain key was created (existing readings would no longer verify). */
function ensureServerKeys(): boolean {
  out.step('Server keys');
  let newChainKey = false;

  for (const [file, label] of [
    [PATHS.masterKey, 'master.key  (AES-256: encrypts device secrets, keys OTP HMACs)'],
    [PATHS.chainKey, 'chain.key   (HMAC-SHA256: reading hash chain)'],
  ] as const) {
    if (existsSync(file)) {
      out.skip(`${label} - exists`);
    } else {
      writeSecretFile(file, generateSymmetricKeyFile());
      out.done(label);
      if (file === PATHS.chainKey) newChainKey = true;
    }
  }

  if (existsSync(PATHS.signingPrivateKey) && existsSync(PATHS.signingPublicKey)) {
    out.skip('signing-ed25519.pem (Ed25519: signs device replies + backups) - exists');
  } else {
    const { privatePem, publicPem } = generateEd25519Pem();
    writeSecretFile(PATHS.signingPrivateKey, privatePem);
    writePublicFile(PATHS.signingPublicKey, publicPem);
    out.done('signing-ed25519.pem + .pub.pem (Ed25519: signs device replies + backups)');
  }

  if (existsSync(PATHS.backupPublicKey) && existsSync(PATHS.backupPrivateKey)) {
    out.skip('backup RSA-3072 key pair - exists');
  } else {
    const { privatePem, publicPem } = generateRsa3072Pem();
    writePublicFile(PATHS.backupPublicKey, publicPem);
    writeSecretFile(PATHS.backupPrivateKey, privatePem);
    out.done(
      'server/keys/backup-rsa3072.pub.pem   (RSA-3072 PUBLIC key - server wraps backup keys)',
    );
    out.done(
      'offline-keys/backup-rsa3072.pem      (RSA-3072 PRIVATE key - only for restore, 0600)',
    );
  }
  return newChainKey;
}

// The Prisma client VALUE is imported dynamically in runSetup() because it is
// generated during setup; a type-only import is erased at runtime, so it is safe.
type Prisma = PrismaClient;

async function ensureDevice(prisma: Prisma, keys: ServerKeys): Promise<void> {
  out.step(`Device "${DEVICE_ID}"`);
  const row = await prisma.device.findUnique({ where: { id: DEVICE_ID } });
  const file = existsSync(PATHS.deviceConfig)
    ? (JSON.parse(readFileSync(PATHS.deviceConfig, 'utf8')) as Partial<DeviceFile>)
    : undefined;

  // The device is consistent when device.json and the DB hold the same secret
  // and device.json pins the current server signing key.
  let consistent = false;
  if (row && file?.secret && file.serverSigningPublicKey === keys.signingPublicKeyPem) {
    try {
      consistent = decryptDeviceSecret(keys.masterKey, DEVICE_ID, row.secretEnc).equals(
        Buffer.from(file.secret, 'base64'),
      );
    } catch {
      consistent = false; // master key changed or row altered
    }
  }
  if (consistent) {
    out.skip('device row and device/device.json match - kept');
    return;
  }

  const secret = randomBytes(32);
  const secretEnc = encryptDeviceSecret(keys.masterKey, DEVICE_ID, secret);
  await prisma.device.upsert({
    where: { id: DEVICE_ID },
    create: { id: DEVICE_ID, secretEnc, low: MOISTURE.defaultLow, high: MOISTURE.defaultHigh },
    update: { secretEnc },
  });

  const deviceFile: DeviceFile = {
    deviceId: DEVICE_ID,
    secret: secret.toString('base64'),
    serverUrl: process.env.DEVICE_SERVER_URL ?? 'https://localhost:8443',
    serverCertPath: '../certs/server.crt',
    serverSigningPublicKey: keys.signingPublicKeyPem,
    provisionedAt: new Date().toISOString(),
  };
  writeSecretFile(PATHS.deviceConfig, JSON.stringify(deviceFile, null, 2) + '\n');
  out.done(
    `random 256-bit secret, stored AES-256-GCM encrypted in DB (thresholds ${MOISTURE.defaultLow} / ${MOISTURE.defaultHigh} mm)`,
  );
  out.done('device/device.json written (secret + pinned cert + server Ed25519 public key)');
}

interface NewCredential {
  username: string;
  role: string;
  email: string;
  password: string;
}

async function ensureUsers(prisma: Prisma): Promise<NewCredential[]> {
  out.step('Users');
  const adminEmail = requireEnv('ADMIN_EMAIL');
  const viewerEmail = requireEnv('VIEWER_EMAIL');
  const adminPhone = requireEnv('ADMIN_PHONE');
  if (!EMAIL_PATTERN.test(adminEmail) || !EMAIL_PATTERN.test(viewerEmail)) {
    throw new Error('ADMIN_EMAIL / VIEWER_EMAIL must be valid email addresses');
  }
  if (!E164_PATTERN.test(adminPhone))
    throw new Error('ADMIN_PHONE must be in E.164 format, e.g. +60123456789');

  const wanted = [
    { username: 'admin', role: 'admin' as const, email: adminEmail, phone: adminPhone },
    { username: 'viewer', role: 'viewer' as const, email: viewerEmail, phone: null },
  ];
  const existing = await prisma.user.count({
    where: { username: { in: wanted.map((u) => u.username) } },
  });

  // Passwords cannot be recovered from their hashes. If CREDENTIALS.txt is gone
  // (or a user is missing) new passwords are generated for both accounts.
  if (existing === wanted.length && existsSync(PATHS.credentials)) {
    for (const u of wanted) {
      await prisma.user.update({
        where: { username: u.username },
        data: { email: u.email, phone: u.phone, role: u.role },
      });
    }
    out.skip(
      'admin + viewer exist and CREDENTIALS.txt is present - passwords kept (email/phone refreshed)',
    );
    return [];
  }

  const created: NewCredential[] = [];
  for (const u of wanted) {
    const password = generatePassword();
    const { salt, passHash } = await hashPassword(password);
    await prisma.user.upsert({
      where: { username: u.username },
      create: { ...u, salt, passHash },
      update: { ...u, salt, passHash },
    });
    // Old sessions must not survive a password change.
    await prisma.session.deleteMany({ where: { username: u.username } });
    created.push({ username: u.username, role: u.role, email: u.email, password });
    out.done(
      `${u.username.padEnd(6)} (${u.role}) - random password, scrypt + per-user salt, email ${u.email}`,
    );
  }
  return created;
}

function writeCredentials(creds: NewCredential[]): void {
  out.step('CREDENTIALS.txt');
  if (creds.length === 0) {
    out.skip('unchanged');
    return;
  }
  const port = process.env.SERVER_PORT ?? '8443';
  const devicePort = process.env.DEVICE_PORT ?? '4000';
  const lan = lanIPv4Addresses().map((ip) => `https://${ip}:${port}`);
  const lines = [
    'Secured Soil Moisture Monitoring System - local credentials',
    `Generated: ${new Date().toISOString()}`,
    'KEEP PRIVATE. This file is gitignored. Delete it once you have stored the passwords safely.',
    '',
    'USERS (login = password, then a 6-digit OTP sent by email)',
    ...creds.map(
      (c) => `  ${c.username.padEnd(8)} ${c.password}   role=${c.role}   email=${c.email}`,
    ),
    '',
    'OTP EMAILS',
    '  Without SMTP settings, emails are written to outbox/email-<time>.txt',
    '',
    'URLS',
    `  Virtual Garden (device):   http://localhost:${devicePort}`,
    `  API server:                https://localhost:${port}`,
    `  Android emulator:          run "adb reverse tcp:${port} tcp:${port}", then use https://localhost:${port}`,
    ...(lan.length ? [`  Phone on the same Wi-Fi:   ${lan.join('  ')}`] : []),
    '',
    'RESTORE KEY',
    '  offline-keys/backup-rsa3072.pem - needed only for "npm run restore". Move it offline in real use.',
    '',
  ];
  writeSecretFile(PATHS.credentials, lines.join('\n'));
  out.done('usernames, passwords and URLs written (passwords are NOT shown in this console)');
}

function copyCertToApp(): void {
  out.step('Flutter app certificate pin');
  const cert = readFileSync(PATHS.tlsCert, 'utf8');
  if (existsSync(PATHS.appCert) && readFileSync(PATHS.appCert, 'utf8') === cert) {
    out.skip('app/assets/server.crt is up to date');
    return;
  }
  writePublicFile(PATHS.appCert, cert);
  out.done('certs/server.crt copied to app/assets/server.crt');
}

// ---------------------------------------------------------------------------

export async function runSetup(): Promise<void> {
  const started = Date.now();
  console.log('\x1b[1mSecured Soil Moisture Monitoring System - setup\x1b[0m');

  ensureEnvFile();
  loadEnv();

  await ensureTlsCertificate();
  const newChainKey = ensureServerKeys();
  const keys = loadServerKeys();

  out.step('Database');
  const db = await ensureDatabase(requireEnv('DATABASE_URL'), out.info);
  try {
    prismaCli(['generate', '--no-hints'], true);
    out.done('Prisma client generated');
    prismaCli(['migrate', 'deploy'], true);
    out.done('migrations applied (prisma migrate deploy)');

    const { createPrisma } = await import('../../src/db.js');
    const prisma = createPrisma();
    try {
      if (newChainKey && (await prisma.reading.count()) > 0) {
        out.warn(
          'a NEW chain key was created but readings already exist - they will fail /api/verify. Run "npm run reset".',
        );
      }
      await ensureDevice(prisma, keys);
      const creds = await ensureUsers(prisma);
      writeCredentials(creds);
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    await db.stop();
  }

  copyCertToApp();
  console.log(
    `\n\x1b[32m\x1b[1mSetup complete\x1b[0m in ${((Date.now() - started) / 1000).toFixed(1)} s. Credentials: CREDENTIALS.txt`,
  );
}
