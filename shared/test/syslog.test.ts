import { describe, expect, it } from 'vitest';
import {
  formatRfc5424,
  frameOctetCounting,
  FramingError,
  parseOctetFrames,
  parseRfc5424,
} from '../src/index.js';

const now = new Date('2026-11-08T10:00:00.000Z');
const opts = { appName: 'soil-server', hostname: 'host1', procId: 42, now };

describe('RFC 5424 formatting', () => {
  it('builds PRI, header, structured data and message', () => {
    const line = formatRfc5424(
      {
        severity: 'warning',
        msgId: 'device',
        message: 'Telemetry rejected',
        data: { device: 'celery-node-01', reason: 'bad_signature' },
      },
      opts,
    );
    // local0 (16) * 8 + warning (4) = 132
    expect(line).toBe(
      '<132>1 2026-11-08T10:00:00.000Z host1 soil-server 42 device [soil@32473 device="celery-node-01" reason="bad_signature"] Telemetry rejected',
    );
  });

  it('uses "-" when there is no structured data and maps severities', () => {
    expect(formatRfc5424({ severity: 'crit', msgId: 'chain', message: 'x' }, opts)).toMatch(
      /^<130>1 .* chain - x$/,
    );
    expect(formatRfc5424({ severity: 'info', msgId: 'r', message: 'x' }, opts)).toMatch(/^<134>/);
    expect(formatRfc5424({ severity: 'notice', msgId: 'r', message: 'x' }, opts)).toMatch(/^<133>/);
  });

  it('escapes ", \\ and ] in values and strips newlines (log injection)', () => {
    const line = formatRfc5424(
      {
        severity: 'info',
        msgId: 'auth',
        message: 'line1\nFAKE <130>1 entry',
        data: { user: 'a"b\\c]d\ne' },
      },
      opts,
    );
    expect(line).toContain('user="a\\"b\\\\c\\]d e"');
    expect(line).not.toContain('\n');
    expect(line.endsWith('line1 FAKE <130>1 entry')).toBe(true);
  });

  it('round-trips through the parser', () => {
    const line = formatRfc5424(
      { severity: 'notice', msgId: 'auth', message: 'Login ok', data: { user: 'admin' } },
      opts,
    );
    expect(parseRfc5424(line)).toEqual({
      facility: 16,
      severity: 'notice',
      timestamp: '2026-11-08T10:00:00.000Z',
      hostname: 'host1',
      appName: 'soil-server',
      procId: '42',
      msgId: 'auth',
      structuredData: '[soil@32473 user="admin"]',
      message: 'Login ok',
    });
  });
});

describe('RFC 6587 octet counting', () => {
  it('frames with the byte length (UTF-8 aware)', () => {
    expect(frameOctetCounting('héllo').toString()).toBe('6 héllo');
  });

  it('splits a stream into messages, keeping an incomplete tail', () => {
    const stream = Buffer.concat([
      frameOctetCounting('first'),
      frameOctetCounting('second msg'),
      Buffer.from('12 incompl'),
    ]);
    const { messages, rest } = parseOctetFrames(stream);
    expect(messages).toEqual(['first', 'second msg']);
    expect(rest.toString()).toBe('12 incompl');
  });

  it('handles a frame split across TCP packets', () => {
    const frame = frameOctetCounting('split across packets');
    let rest: Buffer = Buffer.alloc(0);
    const out: string[] = [];
    for (const chunk of [frame.subarray(0, 2), frame.subarray(2, 10), frame.subarray(10)]) {
      const r = parseOctetFrames(Buffer.concat([rest, chunk]));
      out.push(...r.messages);
      rest = r.rest;
    }
    expect(out).toEqual(['split across packets']);
  });

  it('rejects garbage and oversized frames', () => {
    expect(() => parseOctetFrames(Buffer.from('abc hello'))).toThrow(FramingError);
    expect(() => parseOctetFrames(Buffer.from('99999 x'))).toThrow(/too large/);
    expect(() => parseOctetFrames(Buffer.from('1234567890'))).toThrow(FramingError);
  });
});
