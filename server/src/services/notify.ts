/**
 * Outgoing messages: email (OTP codes, alerts) and SMS (alerts).
 *
 *  - Email: nodemailer over SMTP when SMTP_HOST is set (TLS required, the
 *    certificate is always verified); otherwise written to outbox/email-<time>.txt.
 *  - SMS: replaces the GSM module of the original design. Written to
 *    outbox/sms-<time>.txt; the SmsSender interface is ready for Twilio etc.
 *
 * Outbox files may contain OTP codes, so they are created with mode 0600 and
 * the folder is gitignored. Nothing here logs message bodies.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { TIMING } from '@soil/shared';
import type { Config } from '../config.js';
import type { PrismaClient } from '../db.js';
import type { Logger } from '../logger.js';

export interface Mailer {
  /** Human readable description, e.g. "SMTP smtp.gmail.com:587" or "outbox/". */
  readonly description: string;
  send(to: string, subject: string, text: string): Promise<void>;
}

export interface SmsSender {
  readonly description: string;
  send(to: string, text: string): Promise<void>;
}

/** "2026-11-08T10-15-30-123Z-3f9a" - sortable, filesystem safe, unique. */
function outboxStamp(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`;
}

async function writeOutboxFile(dir: string, prefix: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${prefix}-${outboxStamp()}.txt`);
  await writeFile(file, content, { mode: 0o600 });
  return file;
}

/** Development mailer: one text file per email in outbox/. */
export class OutboxMailer implements Mailer {
  readonly description: string;
  constructor(
    private readonly dir: string,
    private readonly from: string,
  ) {
    this.description = `files in ${path.basename(dir)}/`;
  }
  async send(to: string, subject: string, text: string): Promise<void> {
    const content = [
      `From: ${this.from}`,
      `To: ${to}`,
      `Date: ${new Date().toUTCString()}`,
      `Subject: ${subject}`,
      '',
      text,
      '',
    ].join('\n');
    await writeOutboxFile(this.dir, 'email', content);
  }
}

/** Real email over SMTP. TLS is mandatory and the server certificate is verified. */
export class SmtpMailer implements Mailer {
  readonly description: string;
  private readonly transport: Transporter;
  constructor(private readonly config: Config) {
    this.description = `SMTP ${config.SMTP_HOST}:${config.SMTP_PORT}`;
    this.transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE, // true = implicit TLS (465)
      requireTLS: !config.SMTP_SECURE, // otherwise STARTTLS is required, never plaintext
      tls: { minVersion: 'TLSv1.2' },
      ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } } : {}),
    });
  }
  async send(to: string, subject: string, text: string): Promise<void> {
    await this.transport.sendMail({ from: this.config.SMTP_FROM, to, subject, text });
  }
}

/** GSM-module replacement for development: one text file per SMS in outbox/. */
export class OutboxSms implements SmsSender {
  readonly description: string;
  constructor(private readonly dir: string) {
    this.description = `files in ${path.basename(dir)}/`;
  }
  async send(to: string, text: string): Promise<void> {
    await writeOutboxFile(
      this.dir,
      'sms',
      `To: ${to}\nDate: ${new Date().toUTCString()}\n\n${text}\n`,
    );
  }
}

export function createMailer(config: Config): Mailer {
  return config.SMTP_HOST
    ? new SmtpMailer(config)
    : new OutboxMailer(config.OUTBOX_DIR, config.SMTP_FROM);
}

export function createSms(config: Config): SmsSender {
  // Only "file" exists today; a Twilio sender would implement SmsSender.
  return new OutboxSms(config.OUTBOX_DIR);
}

export type OwnerAlertKind = 'motion' | 'offline';

export interface NotifyResult {
  sent: boolean;
  reason?: 'cooldown' | 'no_owner';
}

/**
 * Notifies the owner (the admin user) by SMS + email, at most once per
 * 2 minutes per alert kind - so a flapping sensor cannot flood the phone.
 */
export class OwnerNotifier {
  private readonly lastSent = new Map<OwnerAlertKind, number>();

  constructor(
    private readonly prisma: PrismaClient,
    readonly mailer: Mailer,
    readonly sms: SmsSender,
    private readonly logger: Logger,
    private readonly cooldownMs: number = TIMING.notifyCooldownMs,
  ) {}

  async notify(
    kind: OwnerAlertKind,
    subject: string,
    text: string,
    now = Date.now(),
  ): Promise<NotifyResult> {
    const last = this.lastSent.get(kind);
    if (last !== undefined && now - last < this.cooldownMs) {
      this.logger.info({ kind }, 'Owner notification suppressed (2-minute cooldown)');
      return { sent: false, reason: 'cooldown' };
    }
    const owner = await this.prisma.user.findFirst({
      where: { role: 'admin' },
      orderBy: { createdAt: 'asc' },
    });
    if (!owner) return { sent: false, reason: 'no_owner' };
    this.lastSent.set(kind, now);

    const results = await Promise.allSettled([
      this.mailer.send(owner.email, subject, text),
      owner.phone ? this.sms.send(owner.phone, text) : Promise.resolve(),
    ]);
    for (const r of results) {
      if (r.status === 'rejected')
        this.logger.error({ err: r.reason as unknown, kind }, 'Owner notification failed');
    }
    return { sent: true };
  }
}
