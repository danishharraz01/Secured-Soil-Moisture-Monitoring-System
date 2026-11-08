/**
 * Syslog client: sends RFC 5424 messages over TLS (RFC 5425) with RFC 6587
 * octet-counting framing to the collector on port 6514.
 *
 *  - The collector's certificate is PINNED (same self-signed cert as the API).
 *  - While the collector is down, up to 2000 messages are queued (oldest
 *    dropped first) and the client reconnects every 5 seconds.
 *  - close() flushes the queue on graceful shutdown.
 */
import net from 'node:net';
import tls from 'node:tls';
import { formatRfc5424, frameOctetCounting, type SyslogEvent } from '@soil/shared';
import type { Logger } from '../logger.js';

export interface SyslogStatus {
  connected: boolean;
  queued: number;
  dropped: number;
}

/** What the rest of the server depends on - lets tests use an in-memory sink. */
export interface SyslogSink {
  log(event: SyslogEvent): void;
  status(): SyslogStatus;
  close(): Promise<void>;
}

export interface TlsSyslogOptions {
  host: string;
  port: number;
  /** Pinned collector certificate (PEM). */
  ca: string;
  appName?: string;
  logger: Logger;
  maxQueue?: number;
  reconnectMs?: number;
}

export class TlsSyslogClient implements SyslogSink {
  private socket: tls.TLSSocket | undefined;
  private connected = false;
  private closing = false;
  private queue: Buffer[] = [];
  private dropped = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly maxQueue: number;
  private readonly reconnectMs: number;
  private readonly appName: string;
  private wasDown = false;

  constructor(private readonly opts: TlsSyslogOptions) {
    this.maxQueue = opts.maxQueue ?? 2000;
    this.reconnectMs = opts.reconnectMs ?? 5000;
    this.appName = opts.appName ?? 'soil-server';
  }

  start(): void {
    this.connect();
  }

  log(event: SyslogEvent): void {
    const frame = frameOctetCounting(formatRfc5424(event, { appName: this.appName }));
    this.opts.logger.debug({ syslog: event.severity, msgId: event.msgId }, event.message);
    if (this.connected && this.socket && this.queue.length === 0) {
      this.socket.write(frame);
      return;
    }
    this.queue.push(frame);
    if (this.queue.length > this.maxQueue) {
      this.queue.shift();
      this.dropped++;
    }
  }

  status(): SyslogStatus {
    return { connected: this.connected, queued: this.queue.length, dropped: this.dropped };
  }

  /** Flushes queued messages (best effort, max 2 s) and closes the connection. */
  async close(): Promise<void> {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    if (!socket) return;
    if (this.connected) this.flush();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, 2000);
      socket.end(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private connect(): void {
    if (this.closing) return;
    const { host, port, ca } = this.opts;
    const socket = tls.connect({
      host,
      port,
      ca, // pinning: only the collector's own certificate is trusted
      minVersion: 'TLSv1.2',
      // SNI must be a hostname, not an IP address.
      ...(net.isIP(host) ? {} : { servername: host }),
    });
    this.socket = socket;

    socket.once('secureConnect', () => {
      this.connected = true;
      if (this.wasDown) {
        this.opts.logger.info(
          { queued: this.queue.length },
          'Syslog collector connected - flushing queue',
        );
      } else {
        this.opts.logger.info(`Syslog collector connected (tls://${host}:${port})`);
      }
      this.wasDown = false;
      this.flush();
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!this.wasDown) {
        this.opts.logger.warn(
          `Syslog collector unavailable (${err.code ?? err.message}) - queueing up to ${this.maxQueue} messages, retrying every ${this.reconnectMs / 1000} s`,
        );
      }
      this.wasDown = true;
    });
    socket.once('close', () => {
      this.connected = false;
      this.socket = undefined;
      if (!this.closing) {
        this.wasDown = true;
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
      }
    });
    // The collector never sends data; ignore anything it does send.
    socket.on('data', () => {});
  }

  private flush(): void {
    while (this.connected && this.socket && this.queue.length > 0) {
      this.socket.write(this.queue.shift()!);
    }
  }
}

/** In-memory sink for tests: records every event. */
export class MemorySyslog implements SyslogSink {
  readonly events: SyslogEvent[] = [];
  log(event: SyslogEvent): void {
    this.events.push(event);
  }
  status(): SyslogStatus {
    return { connected: true, queued: 0, dropped: 0 };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}
