/**
 * Everything a route handler needs, created once at startup and passed down.
 * Tests build the same object with in-memory syslog and mail fakes.
 */
import type { PrismaClient } from './db.js';
import type { Logger } from './logger.js';
import type { AuditLog } from './services/audit.js';
import type { BackupService } from './services/backup.js';
import type { OwnerNotifier } from './services/notify.js';
import type { SyslogSink } from './services/syslog.js';
import type { ServerKeys } from './security/keys.js';

export interface AppContext {
  prisma: PrismaClient;
  keys: ServerKeys;
  syslog: SyslogSink;
  audit: AuditLog;
  notifier: OwnerNotifier;
  logger: Logger;
  startedAt: number;
  /** Simulated seconds per real second: 600 in demo mode (1 s = 10 min), 1 in real time. */
  simSpeedFactor: number;
  backup: BackupService;
}
