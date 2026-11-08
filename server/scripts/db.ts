/**
 * `npm run db` - start PostgreSQL (Docker or embedded) and keep it running
 * until Ctrl+C. Used by `npm run demo` when Docker is not installed.
 */
import { loadEnv, requireEnv } from '../src/env.js';
import { ensureDatabase } from './database.js';

loadEnv();
const db = await ensureDatabase(requireEnv('DATABASE_URL'));

if (db.mode === 'embedded') {
  console.log('Press Ctrl+C to stop the database.');
  const shutdown = (): void => {
    console.log('Stopping embedded PostgreSQL...');
    db.stop().then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // Keep the process alive.
  setInterval(() => {}, 1 << 30);
}
