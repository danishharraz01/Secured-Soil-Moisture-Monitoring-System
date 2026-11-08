/**
 * Server configuration, validated with zod at startup. A wrong or missing
 * value stops the server immediately with a clear message instead of failing
 * later in a confusing way.
 */
import path from 'node:path';
import { z } from 'zod';
import { loadEnv } from './env.js';
import { PATHS, REPO_ROOT } from './paths.js';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

/** Relative folder names in .env are resolved against the repository root. */
const dir = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) => path.resolve(REPO_ROOT, v || fallback));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().startsWith('postgresql://', 'DATABASE_URL must be a postgresql:// URL'),

  SERVER_HOST: z.string().default('0.0.0.0'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8443),

  SYSLOG_HOST: z.string().default('localhost'),
  SYSLOG_PORT: z.coerce.number().int().min(1).max(65535).default(6514),

  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default('Soil Monitor <no-reply@example.com>'),

  SMS_PROVIDER: z.enum(['file']).default('file'),
  OUTBOX_DIR: dir('outbox'),
  LOGS_DIR: dir('logs'),

  BACKUP_PROVIDER: z.enum(['local']).default('local'),
  CLOUD_DIR: dir('cloud'),
  BACKUP_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  BACKUP_KEEP: z.coerce.number().int().min(1).max(1000).default(20),

  /** demo = daily report at simulated midnight; realtime = at real midnight. */
  SIM_SPEED: z.enum(['demo', 'realtime']).default('demo'),
});

export type Config = z.infer<typeof schema> & {
  tlsCertPath: string;
  tlsKeyPath: string;
};

/** Parses process.env (after loading .env). Throws a readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadEnv();
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
  }
  return { ...parsed.data, tlsCertPath: PATHS.tlsCert, tlsKeyPath: PATHS.tlsKey };
}
