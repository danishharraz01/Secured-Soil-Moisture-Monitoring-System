/**
 * Prisma client factory. Prisma 7 talks to PostgreSQL through the `pg` driver
 * adapter. All queries are parameterised by Prisma - no string-built SQL.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/prisma/client.js';

export { Prisma, PrismaClient };
export type * from './generated/prisma/client.js';

export function createPrisma(databaseUrl = process.env.DATABASE_URL): PrismaClient {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

/** True when a Prisma error is a unique-constraint violation (e.g. a reused nonce). */
export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
