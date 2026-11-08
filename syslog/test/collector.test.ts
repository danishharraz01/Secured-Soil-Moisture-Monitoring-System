/**
 * Syslog collector + the server's TLS syslog client, over real TLS sockets.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { frameOctetCounting } from '@soil/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateTlsCertificate } from '../../server/scripts/lib/tls.js';
import { silentLogger } from '../../server/src/logger.js';
import { TlsSyslogClient } from '../../server/src/services/syslog.js';
import { SyslogCollector } from '../src/collector.js';

let cert: string;
let key: string;
let otherCert: string;
const cleanup: (() => Promise<void>)[] = [];

beforeAll(async () => {
  ({ certPem: cert, keyPem: key } = await generateTlsCertificate({
    dns: ['localhost'],
    ips: ['127.0.0.1'],
  }));
  otherCert = (await generateTlsCertificate({ dns: ['localhost'], ips: ['127.0.0.1'] })).certPem;
});

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(20);
  }
}

async function startCollector(port = 0) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'soil-syslog-'));
  const lines: string[] = [];
  const collector = new SyslogCollector({
    cert,
    key,
    host: '127.0.0.1',
    port,
    logFile: path.join(dir, 'syslog.log'),
    print: (l) => lines.push(l),
  });
  const boundPort = await collector.start();
  cleanup.push(() => collector.stop());
  return { collector, port: boundPort, lines, logFile: path.join(dir, 'syslog.log') };
}

function client(port: number, ca = cert) {
  const c = new TlsSyslogClient({
    host: 'localhost',
    port,
    ca,
    logger: silentLogger,
    reconnectMs: 100,
  });
  cleanup.push(() => c.close());
  return c;
}

describe('syslog collector', () => {
  it('receives RFC 5424 messages over TLS, prints them by severity and appends raw lines to the log file', async () => {
    const { collector, port, lines, logFile } = await startCollector();
    const c = client(port);
    c.start();
    c.log({
      severity: 'warning',
      msgId: 'device',
      message: 'device_rejected: replay',
      data: { reason: 'replay' },
    });
    c.log({ severity: 'crit', msgId: 'chain', message: 'Tampering detected at reading #2' });
    await until(() => collector.received === 2);

    expect(
      lines.some((l) =>
        / WARN device {3}device_rejected: replay \[soil@32473 reason="replay"\]/.test(l),
      ),
    ).toBe(true);
    expect(lines.some((l) => / CRIT chain {4}Tampering detected at reading #2/.test(l))).toBe(true);
    await collector.stop();
    const raw = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(raw).toHaveLength(2);
    expect(raw[0]).toMatch(
      /^<132>1 \S+ \S+ soil-server \d+ device \[soil@32473 reason="replay"\] device_rejected: replay$/,
    );
    expect(raw[1]).toMatch(/^<130>1 /);
  });

  it('client queues while the collector is down and flushes when it comes up', async () => {
    // Reserve a free port, then free it so the client initially fails to connect.
    const probe = await startCollector();
    const port = probe.port;
    await probe.collector.stop();

    const c = client(port);
    c.start();
    for (let i = 1; i <= 3; i++)
      c.log({ severity: 'info', msgId: 'reading', message: `queued ${i}` });
    await wait(150);
    expect(c.status()).toMatchObject({ connected: false, queued: 3 });

    const { collector, lines } = await startCollector(port);
    await until(() => collector.received === 3);
    expect(lines.filter((l) => l.includes('queued')).map((l) => l.split(' ').at(-1))).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(c.status()).toMatchObject({ connected: true, queued: 0 });
  });

  it('keeps at most 2000 queued messages (oldest dropped)', () => {
    const c = new TlsSyslogClient({
      host: 'localhost',
      port: 1,
      ca: cert,
      logger: silentLogger,
      maxQueue: 2000,
    });
    for (let i = 0; i < 2005; i++) c.log({ severity: 'info', msgId: 'x', message: String(i) });
    expect(c.status()).toEqual({ connected: false, queued: 2000, dropped: 5 });
  });

  it('client refuses a collector with a different certificate (pinning)', async () => {
    const { collector, port } = await startCollector();
    const c = client(port, otherCert);
    c.start();
    c.log({ severity: 'info', msgId: 'x', message: 'secret event' });
    await wait(300);
    expect(collector.received).toBe(0);
    expect(c.status().connected).toBe(false);
  });

  it('drops a connection that sends garbage instead of octet-counted frames', async () => {
    const { collector, port, lines } = await startCollector();
    const socket = tls.connect({ host: '127.0.0.1', port, ca: cert, servername: 'localhost' });
    await new Promise((r) => socket.once('secureConnect', r));
    socket.write(
      Buffer.concat([
        frameOctetCounting('<134>1 - - - - - - fine'),
        Buffer.from('GET / HTTP/1.1\r\n'),
      ]),
    );
    await new Promise((r) => socket.once('close', r));
    expect(collector.received).toBe(1);
    expect(lines.some((l) => l.includes('dropping') && l.includes('invalid frame length'))).toBe(
      true,
    );
  });
});
