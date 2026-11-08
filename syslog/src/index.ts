/**
 * `npm run syslog` - the syslog collector on tls://localhost:6514.
 * Uses certs/server.* from `npm run setup` and writes logs/syslog.log.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SyslogCollector } from './collector.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.SYSLOG_PORT ?? 6514);
// The API server runs on the same machine, so the collector only listens locally by default.
const host = process.env.SYSLOG_BIND_HOST || '127.0.0.1';
const logFile = path.resolve(ROOT, process.env.SYSLOG_LOG_FILE || 'logs/syslog.log');
const certFile = path.join(ROOT, 'certs', 'server.crt');
const keyFile = path.join(ROOT, 'certs', 'server.key');

if (!existsSync(certFile) || !existsSync(keyFile)) {
  console.error('certs/server.crt not found - run "npm run setup" first');
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid SYSLOG_PORT: ${process.env.SYSLOG_PORT}`);
  process.exit(1);
}

const collector = new SyslogCollector({
  cert: readFileSync(certFile, 'utf8'),
  key: readFileSync(keyFile, 'utf8'),
  host,
  port,
  logFile,
  color: !process.env.NO_COLOR,
});

await collector.start();
console.log(`Syslog collector on tls://${host}:${port} (RFC 5424, octet counting) -> ${path.relative(ROOT, logFile)}`);

const shutdown = (): void => {
  void collector.stop().then(() => {
    console.log(`Syslog collector stopped (${collector.received} messages this session)`);
    process.exit(0);
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
