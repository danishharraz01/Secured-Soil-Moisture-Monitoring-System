/**
 * Loads the repository-root .env into process.env (Node's built-in loader,
 * no extra dependency). Variables already set in the real environment win,
 * so CI and production can override anything.
 */
import { existsSync } from 'node:fs';
import { PATHS } from './paths.js';

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  if (existsSync(PATHS.env)) process.loadEnvFile(PATHS.env);
  loaded = true;
}

/** Returns a required environment variable or throws a clear error. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable ${name} (see .env.example)`);
  }
  return value;
}
