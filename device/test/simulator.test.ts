/**
 * The virtual device driven tick by tick with a fake network link.
 * No timers are started (start() is never called), so tests are deterministic.
 */
import type { DevicePayload } from '@soil/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { SendResult } from '../src/link.js';
import { DeviceSimulator, QUEUE_READING_LIMIT } from '../src/simulator.js';

const ok = (extra: Partial<SendResult> = {}): SendResult => ({
  ok: true,
  status: 200,
  retry: false,
  ciphertextPreview: 'xxxx…',
  latencyMs: 1,
  ...extra,
});
const down: SendResult = {
  ok: false,
  retry: true,
  error: 'server unreachable (connection refused)',
  ciphertextPreview: 'xxxx…',
  latencyMs: 1,
};

/** Lets pending promises (the send queue) settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

let device: DeviceSimulator | undefined;
afterEach(() => device?.stop());

function makeDevice(respond: (p: DevicePayload) => SendResult, initialMoistureMm = 28) {
  const sent: DevicePayload[] = [];
  device = new DeviceSimulator({
    deviceId: 'celery-node-01',
    speed: 'demo',
    motionChance: 0,
    rng: () => 0.5, // no sensor noise, fixed evaporation
    startSimTime: new Date(2026, 10, 8, 2, 0), // night: slow drying
    initialMoistureMm,
    print: () => {},
    link: {
      send: (p) => {
        sent.push(p);
        return Promise.resolve(respond(p));
      },
    },
  });
  return { device, sent };
}

describe('DeviceSimulator', () => {
  it('sends one encrypted reading per tick with simulated time +10 min', async () => {
    const { device, sent } = makeDevice(() => ok());
    const t0 = new Date(device.getState().simTime).getTime();
    device.tick();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'reading', pumpOn: false, waterMl: 0 });
    expect(new Date(device.getState().simTime).getTime() - t0).toBe(10 * 60_000);
    expect(device.getState().link).toBe('online');
  });

  it('waters on its own: pump ON at <= 24.5 mm, OFF at >= 32 mm', async () => {
    const { device, sent } = makeDevice(() => ok(), 24.6);
    const pumpStates: boolean[] = [];
    for (let i = 0; i < 12; i++) {
      device.tick();
      pumpStates.push(device.getState().pumpOn);
    }
    await settle();
    expect(pumpStates[0]).toBe(true); // 24.6 - 0.2 evaporation = 24.4 -> ON
    expect(pumpStates.at(-1)).toBe(false); // climbed past 32 -> OFF
    const readings = sent.filter((p) => p.type === 'reading');
    expect(readings.some((r) => r.type === 'reading' && r.waterMl > 0)).toBe(true);
    expect(device.getState().waterTodayMl).toBeGreaterThan(0);
  });

  it('keeps watering when the server is down (control is on the device)', async () => {
    const { device } = makeDevice(() => down, 24.6);
    device.tick();
    await settle();
    expect(device.getState().pumpOn).toBe(true);
    expect(device.getState().link).toBe('retrying');
  });

  it('keeps only the newest readings while the server is down', async () => {
    const { device } = makeDevice(() => down);
    for (let i = 0; i < QUEUE_READING_LIMIT + 15; i++) device.tick();
    await settle();
    expect(device.getState().queueLength).toBe(QUEUE_READING_LIMIT);
    expect(device.getLog().some((e) => e.message.includes('keeping the newest'))).toBe(true);
  });

  it('"Simulate disconnect" stops all sending, then flushes the queue on reconnect', async () => {
    const { device, sent } = makeDevice(() => ok());
    device.setDisconnected(true);
    for (let i = 0; i < 3; i++) device.tick();
    device.triggerMotion('button');
    await settle();
    expect(sent).toHaveLength(0);
    expect(device.getState()).toMatchObject({ link: 'disconnected', queueLength: 4 });

    device.setDisconnected(false);
    await settle();
    expect(sent.map((p) => p.type)).toEqual([
      'heartbeat',
      'reading',
      'reading',
      'reading',
      'motion',
    ]);
    expect(device.getState().queueLength).toBe(0);
  });

  it('motion turns the red LED on and sends a motion event', async () => {
    const { device, sent } = makeDevice(() => ok());
    device.triggerMotion('button');
    await settle();
    expect(device.getState().ledOn).toBe(true);
    expect(sent[0]).toMatchObject({ type: 'motion', sensor: 'pir-1' });
  });

  it('applies thresholds only from a verified reply, and logs ignored replies', async () => {
    let next: SendResult = ok({ thresholds: { low: 20, high: 30 } });
    const { device } = makeDevice(() => next);
    device.tick();
    await settle();
    expect(device.getState()).toMatchObject({ low: 20, high: 30, thresholdsSource: 'server' });

    next = ok({ replyProblem: 'server signature is invalid' });
    device.tick();
    await settle();
    expect(device.getState()).toMatchObject({ low: 20, high: 30 });
    expect(device.getLog().at(-1)?.message).toBe(
      'Ignored server reply: server signature is invalid',
    );
  });

  it('logs each send with encrypted / signed / server status', async () => {
    const { device } = makeDevice(() => ok());
    device.tick();
    await settle();
    const entry = device.getLog().find((e) => e.kind === 'reading');
    expect(entry?.checks).toEqual({ encrypted: true, signed: true, server: '200', ok: true });
  });
});
