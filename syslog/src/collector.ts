/**
 * Syslog collector: RFC 5425 (syslog over TLS) with RFC 6587 octet-counting
 * framing, RFC 5424 messages. A standard collector (rsyslog, syslog-ng, Kiwi)
 * could receive the same stream.
 *
 *  - TLS 1.2+ with the project certificate (clients pin it)
 *  - each message is printed colour-coded and appended RAW to logs/syslog.log
 *  - malformed framing or oversized frames drop the connection
 *  - at most 32 concurrent connections
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { FramingError, MAX_FRAME_BYTES, parseOctetFrames, parseRfc5424 } from '@soil/shared';
import { formatForConsole } from './console.js';

export interface CollectorOptions {
  cert: string;
  key: string;
  host: string;
  port: number;
  logFile: string;
  /** Console output; defaults to stdout. */
  print?: (line: string) => void;
  color?: boolean;
  maxConnections?: number;
}

export class SyslogCollector {
  private server: tls.Server | undefined;
  private file: WriteStream | undefined;
  private readonly sockets = new Set<tls.TLSSocket>();
  private readonly print: (line: string) => void;
  /** Number of messages received (for tests and the shutdown summary). */
  received = 0;

  constructor(private readonly opts: CollectorOptions) {
    this.print = opts.print ?? ((line) => process.stdout.write(`${line}\n`));
  }

  /** Starts listening; resolves with the bound port (useful with port 0 in tests). */
  async start(): Promise<number> {
    mkdirSync(path.dirname(this.opts.logFile), { recursive: true });
    this.file = createWriteStream(this.opts.logFile, { flags: 'a', mode: 0o640 });

    const server = tls.createServer({
      cert: this.opts.cert,
      key: this.opts.key,
      minVersion: 'TLSv1.2',
    });
    server.maxConnections = this.opts.maxConnections ?? 32;
    server.on('secureConnection', (socket) => this.handle(socket));
    // Failed handshakes (e.g. a client that does not trust our certificate) are reported, not fatal.
    server.on('tlsClientError', (err) => this.print(this.notice(`TLS handshake failed: ${err.message}`)));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host, () => resolve());
    });
    return (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.file ? this.file.end(() => resolve()) : resolve()));
  }

  private handle(socket: tls.TLSSocket): void {
    this.sockets.add(socket);
    const peer = `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`;
    this.print(this.notice(`client connected ${peer} (${socket.getProtocol() ?? 'TLS'})`));
    let pending: Buffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      try {
        const { messages, rest } = parseOctetFrames(pending);
        pending = rest;
        for (const m of messages) this.accept(m);
        if (pending.length > MAX_FRAME_BYTES + 8) throw new FramingError('frame too large');
      } catch (e) {
        const why = e instanceof FramingError ? e.message : 'unreadable data';
        this.print(this.notice(`dropping ${peer}: ${why}`));
        socket.destroy();
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.print(this.notice(`client disconnected ${peer}`));
    });
  }

  private accept(message: string): void {
    this.received++;
    // Raw RFC 5424 line, one per line (control characters were stripped by the sender;
    // strip again here in case another client sends some).
    // eslint-disable-next-line no-control-regex -- removing control characters prevents log injection
    const raw = message.replace(/[\r\n\x00]+/g, ' ');
    this.file?.write(`${raw}\n`);
    this.print(formatForConsole(parseRfc5424(raw), raw, this.opts.color ?? false));
  }

  private notice(text: string): string {
    const time = new Date().toTimeString().slice(0, 8);
    return this.opts.color ? `\x1b[90m${time} ---- collector: ${text}\x1b[0m` : `${time} ---- collector: ${text}`;
  }
}
