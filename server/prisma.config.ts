/**
 * Prisma 7 configuration. Prisma no longer reads .env by itself, so the
 * repository-root .env is loaded here (if present - CI sets real env vars).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

const rootEnv = path.join(import.meta.dirname, '..', '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Optional so `prisma generate` works without a database (e.g. in CI typecheck).
    url: process.env.DATABASE_URL ?? '',
  },
});
