/**
 * Colour-coded console view of syslog messages:
 *   INFO (grey)  NOTE (green)  WARN (yellow)  CRIT (red, bold)
 */
import type { ParsedSyslog, Severity } from '@soil/shared';

const LABEL: Record<Severity, string> = {
  emerg: 'EMRG',
  alert: 'ALRT',
  crit: 'CRIT',
  err: 'ERR ',
  warning: 'WARN',
  notice: 'NOTE',
  info: 'INFO',
  debug: 'DBUG',
};

const COLOUR: Record<Severity, string> = {
  emerg: '\x1b[1;41;97m',
  alert: '\x1b[1;41;97m',
  crit: '\x1b[1;31m',
  err: '\x1b[31m',
  warning: '\x1b[33m',
  notice: '\x1b[32m',
  info: '\x1b[37m',
  debug: '\x1b[90m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[90m';

/** Local HH:MM:SS of an RFC 3339 timestamp (falls back to the raw value). */
function time(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts.slice(0, 8) : d.toTimeString().slice(0, 8);
}

export function formatForConsole(
  msg: ParsedSyslog | undefined,
  raw: string,
  color: boolean,
): string {
  if (!msg)
    return color ? `${DIM}???? (not RFC 5424) ${raw}${RESET}` : `???? (not RFC 5424) ${raw}`;
  const label = LABEL[msg.severity];
  const head = `${time(msg.timestamp)} ${label} ${msg.msgId.padEnd(8)}`;
  const sd = msg.structuredData === '-' ? '' : ` ${msg.structuredData}`;
  if (!color) return `${head} ${msg.message}${sd}`;
  return `${COLOUR[msg.severity]}${head} ${msg.message}${RESET}${DIM}${sd}${RESET}`;
}
