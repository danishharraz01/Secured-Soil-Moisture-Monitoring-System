/** `npm run setup` - see lib/setup.ts. */
import { runSetup } from './lib/setup.js';

try {
  await runSetup();
} catch (e) {
  console.error(`\n\x1b[31mSetup failed:\x1b[0m ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
