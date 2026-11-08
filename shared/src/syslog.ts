/**
 * Syslog message format (RFC 5424) and TCP framing (RFC 6587 octet counting).
 * Shared by the API server (sender) and the syslog collector (receiver).
 *
 *   <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [SD-ELEMENT] MSG
 *   e.g. <132>1 2026-11-08T10:00:00.000Z host soil-server 4242 device
 *        [soil@32473 device="celery-node-01" reason="bad_signature"] Telemetry rejected
 *
 * Framing: "<byte length> <message>" so messages may safely contain any bytes.
 */
import { hostname } from 'node:os';

export const SEVERITIES = [
  'emerg',
  'alert',
  'crit',
  'err',
  'warning',
  'notice',
  'info',
  'debug',
] as const;
export type Severity = (typeof SEVERITIES)[number];

/** local0 - the facility conventionally used by applications. */
export const FACILITY_LOCAL0 = 16;

/**
 * Structured-data ID. 32473 is the Private Enterprise Number reserved for
 * documentation and examples (RFC 5612) - appropriate for a demo project.
 */
export const SD_ID = 'soil@32473';

export type SyslogData = Record<string, string | number | boolean | null | undefined>;

export interface SyslogEvent {
  severity: Severity;
  /** Short event category, e.g. "device", "auth", "reading", "chain". */
  msgId: string;
  message: string;
  data?: SyslogData;
}

export interface FormatOptions {
  appName: string;
  hostname?: string;
  procId?: string | number;
  now?: Date;
}

/** RFC 5424 PRINTUSASCII (33-126), at most `max` characters, "-" when empty. */
function headerField(value: string, max: number): string {
  const clean = value.replace(/[^\x21-\x7e]/g, '').slice(0, max);
  return clean || '-';
}

/** SD-PARAM value: escape '"', '\' and ']' (RFC 5424 section 6.3.3); no control characters. */
function sdValue(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point (log injection)
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/(["\\\]])/g, '\\$1');
}

/** SD-PARAM name: printable ASCII without '=', ' ', ']' and '"', max 32 characters. */
function sdName(name: string): string {
  return headerField(name.replace(/[= \]"]/g, '_'), 32);
}

export function formatRfc5424(event: SyslogEvent, opts: FormatOptions): string {
  const pri = FACILITY_LOCAL0 * 8 + SEVERITIES.indexOf(event.severity);
  const timestamp = (opts.now ?? new Date()).toISOString();
  const host = headerField(opts.hostname ?? hostname(), 255);
  const app = headerField(opts.appName, 48);
  const proc = headerField(String(opts.procId ?? process.pid), 128);
  const msgId = headerField(event.msgId, 32);

  const params = Object.entries(event.data ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${sdName(k)}="${sdValue(String(v))}"`);
  const sd = params.length ? `[${SD_ID} ${params.join(' ')}]` : '-';

  // One line per message: newlines and other control characters become spaces.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point (log injection)
  const msg = event.message.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  return `<${pri}>1 ${timestamp} ${host} ${app} ${proc} ${msgId} ${sd} ${msg}`;
}

/** RFC 6587 octet-counting frame: "<length> <message>". */
export function frameOctetCounting(message: string): Buffer {
  const body = Buffer.from(message, 'utf8');
  return Buffer.concat([Buffer.from(`${body.length} `, 'ascii'), body]);
}

/** Largest frame the collector accepts (RFC 5425 requires at least 2048; 8 KiB is plenty). */
export const MAX_FRAME_BYTES = 8 * 1024;

export class FramingError extends Error {}

/**
 * Splits a TCP byte stream into octet-counted messages. Returns complete
 * messages and the unconsumed remainder (an incomplete frame). Throws
 * FramingError on a malformed or oversized length so the connection can be dropped.
 */
export function parseOctetFrames(buffer: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space === -1) {
      if (buffer.length - offset > 6) throw new FramingError('frame length too long');
      break; // length digits not complete yet
    }
    const lenText = buffer.subarray(offset, space).toString('ascii');
    if (!/^[1-9]\d{0,5}$/.test(lenText)) throw new FramingError('invalid frame length');
    const len = Number(lenText);
    if (len > MAX_FRAME_BYTES) throw new FramingError('frame too large');
    if (space + 1 + len > buffer.length) break; // body not complete yet
    messages.push(buffer.subarray(space + 1, space + 1 + len).toString('utf8'));
    offset = space + 1 + len;
  }
  return { messages, rest: buffer.subarray(offset) };
}

export interface ParsedSyslog {
  severity: Severity;
  facility: number;
  timestamp: string;
  hostname: string;
  appName: string;
  procId: string;
  msgId: string;
  structuredData: string;
  message: string;
}

const RFC5424 =
  /^<(\d{1,3})>1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|\[(?:[^\]\\]|\\.)*\](?:\[(?:[^\]\\]|\\.)*\])*) ?(.*)$/s;

/** Parses an RFC 5424 message. Returns undefined if it does not match the format. */
export function parseRfc5424(line: string): ParsedSyslog | undefined {
  const m = RFC5424.exec(line);
  if (!m) return undefined;
  const pri = Number(m[1]);
  if (pri > 191) return undefined;
  return {
    facility: Math.floor(pri / 8),
    severity: SEVERITIES[pri % 8]!,
    timestamp: m[2]!,
    hostname: m[3]!,
    appName: m[4]!,
    procId: m[5]!,
    msgId: m[6]!,
    structuredData: m[7]!,
    message: m[8] ?? '',
  };
}
