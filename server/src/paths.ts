/**
 * Absolute paths of every file/folder the system reads or writes.
 * All runtime paths are relative to the repository root, so scripts work no
 * matter which directory they are started from.
 */
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const at = (...parts: string[]): string => path.join(REPO_ROOT, ...parts);

export const PATHS = {
  root: REPO_ROOT,
  env: at('.env'),
  envExample: at('.env.example'),
  credentials: at('CREDENTIALS.txt'),

  /** TLS certificate shared by the API server and the syslog collector. */
  certsDir: at('certs'),
  tlsCert: at('certs', 'server.crt'),
  tlsKey: at('certs', 'server.key'),

  /** Server secrets (gitignored). */
  serverKeysDir: at('server', 'keys'),
  masterKey: at('server', 'keys', 'master.key'),
  chainKey: at('server', 'keys', 'chain.key'),
  signingPrivateKey: at('server', 'keys', 'signing-ed25519.pem'),
  signingPublicKey: at('server', 'keys', 'signing-ed25519.pub.pem'),
  backupPublicKey: at('server', 'keys', 'backup-rsa3072.pub.pem'),

  /** The backup PRIVATE key never lives next to the server - "offline" storage. */
  offlineKeysDir: at('offline-keys'),
  backupPrivateKey: at('offline-keys', 'backup-rsa3072.pem'),

  /** Device provisioning file (secret + pinned server identity). */
  deviceConfig: at('device', 'device.json'),

  /** Flutter app pins this certificate. */
  appCert: at('app', 'assets', 'server.crt'),

  /** Embedded PostgreSQL data directory (used only when Docker is not available). */
  embeddedPgDir: at('data', 'pg'),

  outboxDir: at('outbox'),
  logsDir: at('logs'),
  cloudDir: at('cloud'),
  restoredDir: at('restored'),
} as const;
