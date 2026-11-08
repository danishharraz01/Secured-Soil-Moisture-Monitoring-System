import { describe, expect, it } from 'vitest';
import { DEVICE_ID_PATTERN, MOISTURE, NONCE_PATTERN, validThresholds } from '../src/index.js';

describe('MOISTURE constants', () => {
  it('match the proposal (mm, 0-50, pump on at 24.5, off at 32)', () => {
    expect(MOISTURE).toMatchObject({ unit: 'mm', max: 50, defaultLow: 24.5, defaultHigh: 32 });
  });

  it('defaults are themselves valid thresholds', () => {
    expect(validThresholds(MOISTURE.defaultLow, MOISTURE.defaultHigh)).toBe(true);
  });
});

describe('validThresholds(low, high)', () => {
  it.each([
    [24.5, 32],
    [5, 7],
    [48, 50],
    [28.1, 30.1], // floating point: 30.1 - 28.1 = 1.9999999999999993
  ])('accepts low=%s high=%s', (low, high) => {
    expect(validThresholds(low, high)).toBe(true);
  });

  it.each([
    [4.9, 32, 'low below 5'],
    [24.5, 50.1, 'high above 50'],
    [30, 31.9, 'gap below 2 mm'],
    [32, 24.5, 'low above high'],
    [Number.NaN, 32, 'NaN'],
    [24.5, Number.POSITIVE_INFINITY, 'Infinity'],
  ])('rejects low=%s high=%s (%s)', (low, high) => {
    expect(validThresholds(low, high)).toBe(false);
  });
});

describe('protocol patterns', () => {
  it('accepts the demo device ID and rejects injection attempts', () => {
    expect(DEVICE_ID_PATTERN.test('celery-node-01')).toBe(true);
    expect(DEVICE_ID_PATTERN.test("celery' OR '1'='1")).toBe(false);
    expect(DEVICE_ID_PATTERN.test('CELERY')).toBe(false);
    expect(DEVICE_ID_PATTERN.test('a'.repeat(33))).toBe(false);
  });

  it('accepts only 16-byte lowercase hex nonces', () => {
    expect(NONCE_PATTERN.test('0'.repeat(32))).toBe(true);
    expect(NONCE_PATTERN.test('0'.repeat(31))).toBe(false);
    expect(NONCE_PATTERN.test('G'.repeat(32))).toBe(false);
  });
});
