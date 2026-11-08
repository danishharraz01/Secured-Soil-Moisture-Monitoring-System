/**
 * vitest globalSetup for integration tests: makes sure PostgreSQL runs
 * (Docker, CI service or embedded), creates the separate test database and
 * applies the migrations. The dev database is never touched.
 */
import pg from 'pg';
import { loadEnv } from '../../src/env.js';
import { ensureDatabase } from '../../scripts/database.js';
import { prismaCli } from '../../scripts/lib/prisma-cli.js';

export default async function setup(): Promise<() => Promise<void>> {
  loadEnv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.example)');
  if (url === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL - tests wipe their database');
  }

  const db = await ensureDatabase(url, () => {});

  // CREATE DATABASE cannot be parameterised, so the name is strictly validated first.
  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(dbName))
    throw new Error(`Unsafe test database name: ${dbName}`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }

  const devUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  try {
    prismaCli(['migrate', 'deploy'], true);
  } finally {
    process.env.DATABASE_URL = devUrl;
  }

  return async () => {
    await db.stop();
  };
}
