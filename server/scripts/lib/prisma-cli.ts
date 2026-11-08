/** Runs the Prisma CLI with the current Node binary (no shell, works on Windows). */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PATHS } from '../../src/paths.js';

const PRISMA_CLI = path.join(PATHS.root, 'node_modules', 'prisma', 'build', 'index.js');

export function prismaCli(args: string[], quiet = false): void {
  const r = spawnSync(process.execPath, [PRISMA_CLI, ...args], {
    cwd: path.join(PATHS.root, 'server'),
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    if (quiet) process.stderr.write(`${r.stdout}${r.stderr}`);
    throw new Error(`prisma ${args.join(' ')} failed`);
  }
}
