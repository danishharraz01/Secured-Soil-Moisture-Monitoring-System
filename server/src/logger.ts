/**
 * Application log (pino). Secrets are redacted defensively even though the
 * code never passes them to the logger: passwords, tokens, OTP codes, keys,
 * Authorization headers and device secrets are replaced with "[redacted]".
 */
import pino, { type Logger } from 'pino';

export type { Logger };

const REDACT = [
  'password',
  'token',
  'otp',
  'secret',
  'key',
  'authorization',
  '*.password',
  '*.token',
  '*.otp',
  '*.secret',
  '*.key',
  '*.authorization',
  'req.headers.authorization',
  'req.headers["x-signature"]',
];

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    base: undefined, // no pid/hostname noise
    redact: { paths: REDACT, censor: '[redacted]' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss',
              ignore: 'pid,hostname',
              singleLine: true,
            },
          },
        }
      : {}),
  });
}

/** A logger that writes nothing - used in tests. */
export const silentLogger: Logger = pino({ level: 'silent' });
