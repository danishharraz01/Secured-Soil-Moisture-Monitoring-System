/**
 * API server entry point: HTTPS only (TLS 1.2+), certificate from `npm run setup`.
 * Starts the device watcher and connects to the syslog collector.
 */
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { createPrisma } from './db.js';
import { DeviceWatcher } from './device/watcher.js';
import { createLogger } from './logger.js';
import { loadServerKeys } from './security/keys.js';
import { AuditLog } from './services/audit.js';
import { BackupService, LocalDirStore } from './services/backup.js';
import { createMailer, createSms, OwnerNotifier } from './services/notify.js';
import { SIM_FACTOR } from './services/simclock.js';
import { TlsSyslogClient } from './services/syslog.js';

const config = loadConfig();
// Human-readable logs in development (also when piped through concurrently), JSON in production.
const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV !== 'production');

async function main(): Promise<void> {
  const keys = loadServerKeys();
  const cert = readFileSync(config.tlsCertPath, 'utf8');
  const key = readFileSync(config.tlsKeyPath, 'utf8');

  const prisma = createPrisma(config.DATABASE_URL);
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    throw new Error(
      'Cannot reach PostgreSQL - start it with "npm run db" (or docker compose up -d)',
    );
  }

  const syslog = new TlsSyslogClient({
    host: config.SYSLOG_HOST,
    port: config.SYSLOG_PORT,
    ca: cert,
    logger,
  });
  syslog.start();

  const mailer = createMailer(config);
  const sms = createSms(config);
  const audit = new AuditLog(prisma, syslog, logger);
  const backup = new BackupService(
    prisma,
    keys,
    new LocalDirStore(config.CLOUD_DIR),
    audit,
    logger,
    config.BACKUP_KEEP,
  );
  const ctx: AppContext = {
    prisma,
    keys,
    syslog,
    audit,
    notifier: new OwnerNotifier(prisma, mailer, sms, logger),
    backup,
    logger,
    startedAt: Date.now(),
    simSpeedFactor: SIM_FACTOR[config.SIM_SPEED],
  };

  const watcher = new DeviceWatcher(ctx);
  watcher.start();
  backup.start(config.BACKUP_INTERVAL_MINUTES * 60_000);
  logger.info(
    `Encrypted backup every ${config.BACKUP_INTERVAL_MINUTES} min to ${backup.store.description} (keeps ${config.BACKUP_KEEP})`,
  );

  const server = https.createServer(
    { cert, key, minVersion: 'TLSv1.2' }, // TLS 1.0/1.1 refused
    createApp(ctx),
  );
  server.listen(config.SERVER_PORT, config.SERVER_HOST, () => {
    logger.info(
      `API server listening on https://localhost:${config.SERVER_PORT} (TLS 1.2+, ${config.SERVER_HOST})`,
    );
    logger.info(`Email: ${mailer.description} · SMS: ${sms.description}`);
  });
  syslog.log({ severity: 'notice', msgId: 'server', message: 'API server started' });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received - shutting down`);
    watcher.stop();
    backup.stop();
    server.close();
    syslog.log({ severity: 'notice', msgId: 'server', message: 'API server stopping' });
    void (async () => {
      await syslog.close(); // flush queued syslog messages
      await prisma.$disconnect();
      process.exit(0);
    })();
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  logger.fatal(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
