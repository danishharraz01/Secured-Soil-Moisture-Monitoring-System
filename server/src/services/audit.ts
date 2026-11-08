/**
 * Security audit trail. Every security event is written to the Audit table AND
 * sent to syslog with a severity derived from the action:
 *
 *   CRIT     tampering, device offline
 *   WARNING  rejected / failed / blocked / forbidden / anomaly / otp_wrong / replay
 *   NOTICE   everything else (logins, logouts, config changes, backups...)
 *
 * A failing database write never breaks the request: the event still reaches
 * syslog and the app log.
 */
import type { Severity, SyslogData } from '@soil/shared';
import type { PrismaClient } from '../db.js';
import type { Logger } from '../logger.js';
import type { SyslogSink } from './syslog.js';

export type AuditSeverity = Extract<Severity, 'crit' | 'warning' | 'notice'>;

export interface AuditEntry {
  /** Username, device ID or "anonymous". */
  actor: string;
  /** snake_case event name, e.g. "device_rejected", "login_failed". */
  action: string;
  detail: string;
  ip?: string | undefined;
  /** Overrides the severity derived from the action name. */
  severity?: AuditSeverity;
  /** Syslog MSGID (category). */
  msgId?: string;
  /** Extra structured data for syslog. */
  data?: SyslogData;
}

const CRIT = /tamper|offline/;
const WARN =
  /rejected|failed|blocked|forbidden|anomaly|otp_wrong|replay|denied|invalid|expired|locked/;

export function severityFor(action: string): AuditSeverity {
  if (CRIT.test(action)) return 'crit';
  if (WARN.test(action)) return 'warning';
  return 'notice';
}

/** Keeps stored values short and single-line (inputs may be attacker-controlled). */
export function clip(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point (log injection)
  const oneLine = value.replace(/[\x00-\x1f\x7f]+/g, ' ');
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export class AuditLog {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly syslog: SyslogSink,
    private readonly logger: Logger,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    const actor = clip(entry.actor, 64);
    const detail = clip(entry.detail, 500);
    const severity = entry.severity ?? severityFor(entry.action);

    this.syslog.log({
      severity,
      msgId: entry.msgId ?? 'security',
      message: `${entry.action}: ${detail}`,
      data: { actor, action: entry.action, ip: entry.ip, ...entry.data },
    });
    const level = severity === 'notice' ? 'info' : 'warn';
    this.logger[level]({ actor, action: entry.action, ip: entry.ip }, detail);

    try {
      await this.prisma.audit.create({
        data: { actor, action: entry.action, detail, ip: entry.ip ?? null },
      });
    } catch (e) {
      this.logger.error({ err: e, action: entry.action }, 'Could not write audit entry');
    }
  }
}
