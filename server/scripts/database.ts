/**
 * Makes sure PostgreSQL is reachable, in this order:
 *   1. DATABASE_URL already accepts connections (Docker already up, CI service, native install)
 *   2. Docker is installed  -> `docker compose up -d --wait db`
 *   3. Otherwise            -> embedded PostgreSQL 16 from node_modules (data in data/pg)
 *
 * Option 3 means the project runs with one command on a machine without
 * Docker. Docker remains the default whenever it is available.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PATHS } from '../src/paths.js';

export type DatabaseMode = 'external' | 'docker' | 'embedded';

export interface RunningDatabase {
  mode: DatabaseMode;
  /** Stops the database if this process started it (embedded only). */
  stop(): Promise<void>;
}

interface DbTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function parseDatabaseUrl(url: string): DbTarget {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

/** True when something accepts TCP connections on host:port. */
export function isPortOpen(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    stdio: 'ignore',
    shell: false,
  });
  return r.status === 0;
}

const isLocal = (host: string): boolean => ['localhost', '127.0.0.1', '::1'].includes(host);

export async function ensureDatabase(
  databaseUrl: string,
  log: (msg: string) => void = console.log,
): Promise<RunningDatabase> {
  const target = parseDatabaseUrl(databaseUrl);
  const noop = async (): Promise<void> => {};

  if (await isPortOpen(target.host, target.port)) {
    log(`PostgreSQL reachable at ${target.host}:${target.port}`);
    return { mode: 'external', stop: noop };
  }
  if (!isLocal(target.host)) {
    throw new Error(`PostgreSQL at ${target.host}:${target.port} is not reachable`);
  }

  if (dockerAvailable()) {
    log('Starting PostgreSQL with Docker Compose (waiting for healthcheck)...');
    const r = spawnSync('docker', ['compose', 'up', '-d', '--wait', 'db'], {
      cwd: PATHS.root,
      stdio: 'inherit',
    });
    if (r.status !== 0) throw new Error('docker compose up failed');
    return { mode: 'docker', stop: noop };
  }

  return startEmbedded(target, log);
}

async function startEmbedded(
  target: DbTarget,
  log: (msg: string) => void,
): Promise<RunningDatabase> {
  log('Docker not found - starting embedded PostgreSQL 16 (data/pg)...');
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  mkdirSync(path.dirname(PATHS.embeddedPgDir), { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: PATHS.embeddedPgDir,
    user: target.user,
    password: target.password,
    port: target.port,
    authMethod: 'scram-sha-256',
    persistent: true,
    // Same as docker-compose: never listen on the LAN.
    postgresFlags: ['-c', 'listen_addresses=localhost'],
    onLog: () => {},
    onError: (e) => {
      const text = e instanceof Error ? e.message : String(e);
      // initdb/postgres print routine notices on stderr; only surface real problems.
      if (/error|fatal|panic/i.test(text)) log(`[embedded-postgres] ${text.trim()}`);
    },
  });

  if (!existsSync(path.join(PATHS.embeddedPgDir, 'PG_VERSION'))) {
    log('Initialising a new embedded database cluster (first run only)...');
    await pg.initialise();
  }
  await pg.start();

  try {
    await pg.createDatabase(target.database);
  } catch (e) {
    if (!/already exists/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }

  log(`Embedded PostgreSQL running on localhost:${target.port}`);
  return {
    mode: 'embedded',
    stop: async () => {
      await pg.stop();
    },
  };
}
