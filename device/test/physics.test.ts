import { MOISTURE } from '@soil/shared';
import { describe, expect, it } from 'vitest';
import { decidePump } from '../src/controller.js';
import { advanceSoil, evaporationMm, isDaytime, PHYSICS, sensorRead } from '../src/physics.js';

const at = (hour: number): Date => new Date(2026, 10, 8, hour, 0, 0);
const fixed = (v: number) => (): number => v;

describe('pump control with hysteresis (Flow 1)', () => {
  const { defaultLow: low, defaultHigh: high } = MOISTURE;

  it('switches the pump ON at <= 24.5 mm', () => {
    expect(decidePump(false, 24.6, low, high)).toBe(false);
    expect(decidePump(false, 24.5, low, high)).toBe(true);
    expect(decidePump(false, 10, low, high)).toBe(true);
  });

  it('keeps watering between the thresholds (no flapping)', () => {
    expect(decidePump(true, 25, low, high)).toBe(true);
    expect(decidePump(true, 31.99, low, high)).toBe(true);
  });

  it('switches the pump OFF at >= 32 mm (prevents waterlogging)', () => {
    expect(decidePump(true, 32, low, high)).toBe(false);
    expect(decidePump(true, 40, low, high)).toBe(false);
  });

  it('stays off between the thresholds while drying', () => {
    expect(decidePump(false, 28, low, high)).toBe(false);
  });

  it('runs a full cycle: dry -> ON -> wet -> OFF', () => {
    let pump = false;
    const states: boolean[] = [];
    for (const mm of [27, 25, 24.5, 26, 30, 32.1, 30, 25]) {
      pump = decidePump(pump, mm, low, high);
      states.push(pump);
    }
    expect(states).toEqual([false, false, true, true, true, false, false, false]);
  });
});

describe('soil physics', () => {
  it('uses daytime 09:00-17:59', () => {
    expect(isDaytime(at(8))).toBe(false);
    expect(isDaytime(at(9))).toBe(true);
    expect(isDaytime(at(17))).toBe(true);
    expect(isDaytime(at(18))).toBe(false);
  });

  it('evaporates 0.36-0.48 mm per 10 min by day and 0.14-0.26 mm at night', () => {
    expect(evaporationMm(at(12), 10, fixed(0))).toBeCloseTo(0.36);
    expect(evaporationMm(at(12), 10, fixed(0.999999))).toBeCloseTo(0.48, 4);
    expect(evaporationMm(at(2), 10, fixed(0))).toBeCloseTo(0.14);
    expect(evaporationMm(at(2), 10, fixed(0.999999))).toBeCloseTo(0.26, 4);
  });

  it('scales with the step length', () => {
    expect(evaporationMm(at(12), 1, fixed(0))).toBeCloseTo(0.036);
  });

  it('pump adds 1.3 mm per 10 min and reports the water used', () => {
    const step = advanceSoil(25, true, at(2), 10, fixed(0));
    expect(step.moistureMm).toBeCloseTo(25 - 0.14 + 1.3);
    expect(step.waterMl).toBe(PHYSICS.pumpMlPer10Min);
    expect(advanceSoil(25, false, at(2), 10, fixed(0)).waterMl).toBe(0);
  });

  it('never leaves 0-50 mm', () => {
    expect(advanceSoil(0.05, false, at(12), 10, fixed(1)).moistureMm).toBe(0);
    expect(advanceSoil(49.9, true, at(2), 10, fixed(0)).moistureMm).toBe(50);
  });

  it('sensor noise stays within +-0.12 mm', () => {
    expect(sensorRead(30, fixed(0))).toBeCloseTo(29.88);
    expect(sensorRead(30, fixed(0.5))).toBe(30);
    expect(sensorRead(30, fixed(0.999999))).toBeCloseTo(30.12);
    for (let i = 0; i < 200; i++) {
      expect(Math.abs(sensorRead(30, Math.random) - 30)).toBeLessThanOrEqual(0.12 + 1e-9);
    }
  });
});
