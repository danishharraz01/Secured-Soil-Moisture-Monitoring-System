/**
 * The virtual NodeMCU: soil moisture sensor + relay + water pump + sprinkler
 * + PIR motion sensor + red LED.
 *
 * Flow 1 (sensor node): every tick the sensor is read, the device itself
 * switches the pump with hysteresis, and the reading is encrypted, signed and
 * sent. Flow 3 (motion): PIR -> red LED for 60 s -> encrypted motion event.
 * Flow 4 (heartbeat): a signed heartbeat every 10 s real time.
 *
 * Emits 'state' (DeviceState) and 'log' (LogEntry) for the Virtual Garden page.
 */
import { EventEmitter } from 'node:events';
import { MOISTURE, SIMULATION, TIMING, type DevicePayload } from '@soil/shared';
import type { Speed } from './config.js';
import { decidePump } from './controller.js';
import type { SendResult, ServerLink } from './link.js';
import { advanceSoil, isDaytime, round2, sensorRead, type Rng } from './physics.js';

export type LinkStatus = 'connecting' | 'online' | 'retrying' | 'disconnected';

export interface DeviceState {
  deviceId: string;
  simTime: string;
  daytime: boolean;
  speed: Speed;
  /** Latest sensor value (mm) - what the device reports. */
  moistureMm: number;
  pumpOn: boolean;
  low: number;
  high: number;
  /** 'default' until a signed server reply confirms the thresholds. */
  thresholdsSource: 'default' | 'server';
  waterTodayMl: number;
  ledOn: boolean;
  motionCount: number;
  link: LinkStatus;
  lastError: string | null;
  queueLength: number;
  uptimeS: number;
  stats: { sent: number; rejected: number; failed: number };
}

export interface LogEntry {
  id: number;
  at: string;
  kind: 'reading' | 'heartbeat' | 'motion' | 'pump' | 'control' | 'link' | 'config';
  level: 'ok' | 'info' | 'warn' | 'error';
  message: string;
  /** Present for messages sent to the server. */
  checks?: { encrypted: boolean; signed: boolean; server: string; ok: boolean };
  detail?: string;
}

export interface SimulatorOptions {
  deviceId: string;
  link: Pick<ServerLink, 'send'>;
  speed: Speed;
  motionChance: number;
  rng?: Rng;
  startSimTime?: Date;
  initialMoistureMm?: number;
  /** Terminal output (state changes and errors only - never secrets). */
  print?: (line: string) => void;
}

/** Keep at most this many unsent readings (newest win) while the server is down. */
export const QUEUE_READING_LIMIT = 20;
const QUEUE_TOTAL_LIMIT = 50;
const LOG_LIMIT = 200;
const MAX_BACKOFF_MS = 30_000;

interface Queued {
  payload: DevicePayload;
}

export class DeviceSimulator extends EventEmitter {
  readonly deviceId: string;
  private readonly link: Pick<ServerLink, 'send'>;
  private readonly rng: Rng;
  private readonly print: (line: string) => void;
  private readonly motionChance: number;
  private readonly startedAt = Date.now();

  private speed: Speed;
  private simTime: Date;
  private trueMm: number;
  private measuredMm: number;
  private pumpOn = false;
  private low: number = MOISTURE.defaultLow;
  private high: number = MOISTURE.defaultHigh;
  private thresholdsSource: DeviceState['thresholdsSource'] = 'default';
  private waterTodayMl = 0;
  private pendingWaterMl = 0;
  private ledUntil = 0;
  private motionCount = 0;

  private linkStatus: LinkStatus = 'connecting';
  private lastError: string | null = null;
  private disconnected = false;
  private queue: Queued[] = [];
  private draining = false;
  private backoffMs = 0;
  private droppedThisOutage = false;
  private readonly stats = { sent: 0, rejected: 0, failed: 0 };

  private log: LogEntry[] = [];
  private logId = 0;

  private tickTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private ledTimer: NodeJS.Timeout | undefined;

  constructor(opts: SimulatorOptions) {
    super();
    this.deviceId = opts.deviceId;
    this.link = opts.link;
    this.speed = opts.speed;
    this.motionChance = opts.motionChance;
    this.rng = opts.rng ?? Math.random;
    this.print = opts.print ?? ((line) => console.log(line));
    this.simTime = opts.startSimTime ?? new Date();
    this.trueMm = opts.initialMoistureMm ?? 28;
    this.measuredMm = round2(this.trueMm);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    this.addLog('control', 'info', `Device ${this.deviceId} booted (${this.speedLabel()})`);
    this.restartTicker();
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), TIMING.heartbeatMs);
    void this.sendHeartbeat();
  }

  stop(): void {
    for (const t of [this.tickTimer, this.retryTimer, this.ledTimer]) clearTimeout(t);
    clearInterval(this.tickTimer);
    clearInterval(this.heartbeatTimer);
  }

  private restartTicker(): void {
    clearInterval(this.tickTimer);
    const ms = this.speed === 'demo' ? SIMULATION.demoTickMs : SIMULATION.realtimeTickMs;
    this.tickTimer = setInterval(() => this.tick(), ms);
  }

  private simMinutesPerTick(): number {
    return this.speed === 'demo' ? SIMULATION.stepMinutes : SIMULATION.realtimeTickMs / 60_000;
  }

  private speedLabel(): string {
    return this.speed === 'demo' ? 'demo speed: 1 s = 10 min' : 'real time';
  }

  // -------------------------------------------------------------------------
  // Flow 1: sensor -> microcontroller -> relay/pump -> encrypted reading
  // -------------------------------------------------------------------------

  /** One simulation step. Public so tests can drive the device without timers. */
  tick(): void {
    const minutes = this.simMinutesPerTick();
    const step = advanceSoil(this.trueMm, this.pumpOn, this.simTime, minutes, this.rng);
    this.trueMm = step.moistureMm;
    this.pendingWaterMl += step.waterMl;

    const prevDay = this.simTime.toDateString();
    this.simTime = new Date(this.simTime.getTime() + minutes * 60_000);
    if (this.simTime.toDateString() !== prevDay) this.waterTodayMl = 0;
    this.waterTodayMl += step.waterMl;

    // Sensor -> microcontroller -> "Soil moisture <= low?"
    this.measuredMm = sensorRead(this.trueMm, this.rng);
    const nextPump = decidePump(this.pumpOn, this.measuredMm, this.low, this.high);
    if (nextPump !== this.pumpOn) {
      this.pumpOn = nextPump;
      const msg = nextPump
        ? `Relay ON - soil ${this.measuredMm.toFixed(1)} mm <= ${this.low} mm, water pump started`
        : `Relay OFF - soil reached ${this.measuredMm.toFixed(1)} mm (>= ${this.high} mm), pump stopped`;
      this.addLog('pump', 'info', msg);
      this.print(msg);
    }

    const waterMl = Math.round(this.pendingWaterMl);
    this.pendingWaterMl -= waterMl;
    this.enqueue({
      type: 'reading',
      moistureMm: this.measuredMm,
      pumpOn: this.pumpOn,
      waterMl,
      simTime: this.simTime.toISOString(),
    });

    if (this.motionChance > 0 && this.rng() < this.motionChance) this.triggerMotion('random');
    this.emitState();
  }

  // -------------------------------------------------------------------------
  // Flow 3: PIR motion -> red LED -> encrypted motion event
  // -------------------------------------------------------------------------

  triggerMotion(source: 'button' | 'random'): void {
    this.ledUntil = Date.now() + TIMING.ledOnMs;
    this.motionCount++;
    const msg = `PIR motion detected (${source === 'button' ? 'button' : 'random'}) - red LED on for 60 s`;
    this.addLog('motion', 'warn', msg);
    this.print(msg);
    clearTimeout(this.ledTimer);
    this.ledTimer = setTimeout(() => this.emitState(), TIMING.ledOnMs + 50);
    this.enqueue({ type: 'motion', sensor: 'pir-1', simTime: this.simTime.toISOString() });
    this.emitState();
  }

  // -------------------------------------------------------------------------
  // Flow 4: heartbeat every 10 s (not queued - only "now" matters)
  // -------------------------------------------------------------------------

  private async sendHeartbeat(): Promise<void> {
    if (this.disconnected) return;
    const payload: DevicePayload = { type: 'heartbeat', uptime: this.uptimeS() };
    this.handleResult(payload, await this.link.send(payload));
  }

  // -------------------------------------------------------------------------
  // Send queue: retry with exponential backoff, keep the newest readings
  // -------------------------------------------------------------------------

  private enqueue(payload: DevicePayload): void {
    this.queue.push({ payload });
    const readings = this.queue.filter((q) => q.payload.type === 'reading').length;
    if (readings > QUEUE_READING_LIMIT) {
      this.queue.splice(
        this.queue.findIndex((q) => q.payload.type === 'reading'),
        1,
      );
      if (!this.droppedThisOutage) {
        this.droppedThisOutage = true;
        this.addLog(
          'link',
          'warn',
          `Send queue full - keeping the newest ${QUEUE_READING_LIMIT} readings`,
        );
      }
    }
    if (this.queue.length > QUEUE_TOTAL_LIMIT) this.queue.shift();
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disconnected || this.retryTimer) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.disconnected) {
        const item = this.queue[0]!;
        const result = await this.link.send(item.payload);
        this.handleResult(item.payload, result);
        if (result.ok || !result.retry) {
          this.queue.shift();
          continue;
        }
        // Server down: try again later, doubling the wait up to 30 s.
        this.backoffMs = Math.min(this.backoffMs ? this.backoffMs * 2 : 1_000, MAX_BACKOFF_MS);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          void this.drain();
        }, this.backoffMs);
        break;
      }
    } finally {
      this.draining = false;
      this.emitState();
    }
  }

  private handleResult(payload: DevicePayload, r: SendResult): void {
    const what = describePayload(payload);
    // Retries of the same outage are logged once, not on every attempt.
    let logThisSend = true;

    if (r.ok) {
      this.stats.sent++;
      this.backoffMs = 0;
      this.droppedThisOutage = false;
      if (this.linkStatus === 'retrying') {
        const msg = `Server link restored - sending ${this.queue.length} queued message(s)`;
        this.addLog('link', 'info', msg);
        this.print(msg);
      }
      this.linkStatus = 'online';
      this.lastError = null;
    } else if (r.retry) {
      this.stats.failed++;
      logThisSend = r.error !== this.lastError;
      if (logThisSend) this.print(`Send failed: ${r.error} - queueing and retrying with backoff`);
      this.linkStatus = 'retrying';
      this.lastError = r.error ?? 'error';
    } else {
      this.stats.rejected++;
      this.print(`Server rejected ${payload.type}: HTTP ${r.status} ${r.error ?? ''}`);
      this.lastError = r.error ?? `HTTP ${r.status}`;
    }

    if (!logThisSend) return;
    this.addLog(payload.type, r.ok ? 'ok' : 'error', what, {
      checks: {
        encrypted: true,
        signed: true,
        server: r.status ? String(r.status) : 'no reply',
        ok: r.ok,
      },
      detail: r.ok
        ? `ciphertext ${r.ciphertextPreview} · ${r.latencyMs} ms`
        : `${r.error ?? 'error'} · ${r.retry ? 'kept in queue, retrying with backoff (1 s, 2 s, 4 s … 30 s)' : 'rejected, not retried'}`,
    });

    // Thresholds change ONLY through a verified, signed reply.
    if (
      r.thresholds &&
      (r.thresholds.low !== this.low ||
        r.thresholds.high !== this.high ||
        this.thresholdsSource === 'default')
    ) {
      const changed = r.thresholds.low !== this.low || r.thresholds.high !== this.high;
      this.low = r.thresholds.low;
      this.high = r.thresholds.high;
      this.thresholdsSource = 'server';
      const msg = `${changed ? 'New thresholds' : 'Thresholds confirmed'}: ON <= ${this.low} mm, OFF >= ${this.high} mm (Ed25519 signature OK, nonce OK)`;
      this.addLog('config', 'info', msg);
      if (changed) this.print(msg);
    } else if (r.replyProblem) {
      const msg = `Ignored server reply: ${r.replyProblem}`;
      this.addLog('config', 'warn', msg);
      this.print(msg);
    }
  }

  // -------------------------------------------------------------------------
  // Virtual Garden controls
  // -------------------------------------------------------------------------

  /** Manual override from the moisture slider (e.g. to force a watering cycle). */
  setMoisture(mm: number): void {
    this.trueMm = mm;
    this.measuredMm = round2(mm);
    this.addLog('control', 'info', `Manual override - soil moisture set to ${mm.toFixed(1)} mm`);
    this.emitState();
  }

  /** "Simulate disconnect": stop ALL sending (Wi-Fi off). Readings are still taken and queued. */
  setDisconnected(on: boolean): void {
    if (on === this.disconnected) return;
    this.disconnected = on;
    if (on) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.linkStatus = 'disconnected';
      this.addLog(
        'link',
        'warn',
        'Wi-Fi off (simulated disconnect) - nothing is sent; pump control continues locally',
      );
      this.print('Simulated disconnect ON - all sending stopped');
    } else {
      this.linkStatus = 'connecting';
      this.backoffMs = 0;
      this.addLog('link', 'info', 'Wi-Fi back on - sending queued readings');
      this.print('Simulated disconnect OFF - reconnecting');
      void this.sendHeartbeat();
      void this.drain();
    }
    this.emitState();
  }

  setSpeed(speed: Speed): void {
    if (speed === this.speed) return;
    this.speed = speed;
    this.restartTicker();
    this.addLog('control', 'info', `Speed changed: ${this.speedLabel()}`);
    this.emitState();
  }

  // -------------------------------------------------------------------------
  // State for the UI
  // -------------------------------------------------------------------------

  private uptimeS(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  getState(): DeviceState {
    return {
      deviceId: this.deviceId,
      simTime: this.simTime.toISOString(),
      daytime: isDaytime(this.simTime),
      speed: this.speed,
      moistureMm: this.measuredMm,
      pumpOn: this.pumpOn,
      low: this.low,
      high: this.high,
      thresholdsSource: this.thresholdsSource,
      waterTodayMl: Math.round(this.waterTodayMl),
      ledOn: Date.now() < this.ledUntil,
      motionCount: this.motionCount,
      link: this.disconnected ? 'disconnected' : this.linkStatus,
      lastError: this.lastError,
      queueLength: this.queue.length,
      uptimeS: this.uptimeS(),
      stats: { ...this.stats },
    };
  }

  getLog(): LogEntry[] {
    return [...this.log];
  }

  private emitState(): void {
    this.emit('state', this.getState());
  }

  private addLog(
    kind: LogEntry['kind'],
    level: LogEntry['level'],
    message: string,
    extra: Pick<LogEntry, 'checks' | 'detail'> = {},
  ): void {
    const entry: LogEntry = {
      id: ++this.logId,
      at: new Date().toISOString(),
      kind,
      level,
      message,
      ...extra,
    };
    this.log.push(entry);
    if (this.log.length > LOG_LIMIT) this.log.shift();
    this.emit('log', entry);
  }
}

function describePayload(p: DevicePayload): string {
  switch (p.type) {
    case 'reading':
      return `Reading ${p.moistureMm.toFixed(2)} mm, pump ${p.pumpOn ? 'ON' : 'off'}${p.waterMl ? `, ${p.waterMl} ml` : ''}`;
    case 'heartbeat':
      return `Heartbeat (uptime ${p.uptime} s)`;
    case 'motion':
      return `Motion event (${p.sensor})`;
  }
}
