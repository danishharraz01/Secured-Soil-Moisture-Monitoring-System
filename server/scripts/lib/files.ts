/** Small file helpers for the setup scripts. */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Writes a file readable only by the owner (0600). On Windows chmod only
 * toggles the read-only flag; the file still inherits the user-profile ACL,
 * which already excludes other non-admin users.
 */
export function writeSecretFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function writePublicFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { mode: 0o644 });
}

/** Console helpers: consistent, readable setup output. Never pass secrets to these. */
export const out = {
  step: (title: string): void => console.log(`\n\x1b[1m▸ ${title}\x1b[0m`),
  done: (msg: string): void => console.log(`  \x1b[32m✓\x1b[0m ${msg}`),
  skip: (msg: string): void => console.log(`  \x1b[90m• ${msg}\x1b[0m`),
  warn: (msg: string): void => console.log(`  \x1b[33m! ${msg}\x1b[0m`),
  info: (msg: string): void => console.log(`  ${msg}`),
};
