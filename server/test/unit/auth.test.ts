/**
 * OTP helpers, the brute-force limiter and audit severities (no database needed).
 * The full OTP rules (expiry, single use, one wrong -> invalid) and the session
 * hard limit run end-to-end in test/integration/auth-api.test.ts.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LIMIT, LoginLimiter } from '../../src/auth/limiter.js';
import { generateOtp, maskEmail, otpHash, otpMatches } from '../../src/auth/otp.js';
import { clip, severityFor } from '../../src/services/audit.js';

describe('OTP', () => {
  it('is always exactly 6 digits (leading zeros kept)', () => {
    for (let i = 0; i < 2000; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });

  it('is roughly uniform (no obvious bias)', () => {
    const firstDigits = new Map<string, number>();
    for (let i = 0; i < 20_000; i++) {
      const d = generateOtp()[0]!;
      firstDigits.set(d, (firstDigits.get(d) ?? 0) + 1);
    }
    expect(firstDigits.size).toBe(10);
    for (const count of firstDigits.values()) expect(count).toBeGreaterThan(1600); // expected 2000 each
  });

  it('is stored as an HMAC bound to its challenge', () => {
    const key = randomBytes(32);
    const id = randomUUID();
    const stored = otpHash(key, id, '123456');
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain('123456');
    expect(otpMatches(key, id, '123456', stored)).toBe(true);
    expect(otpMatches(key, id, '123457', stored)).toBe(false);
    expect(otpMatches(key, randomUUID(), '123456', stored)).toBe(false); // other challenge
    expect(otpMatches(randomBytes(32), id, '123456', stored)).toBe(false); // other key
  });

  it('masks the email address shown on the OTP screen', () => {
    expect(maskEmail('aaddmiin@mailsac.com')).toBe('a****@mailsac.com');
    expect(maskEmail('x@y.z')).toBe('x****@y.z');
    expect(maskEmail('broken')).toBe('****');
  });
});

describe('brute-force limiter (5 failures / 5 min -> 5 min block)', () => {
  const ip = '203.0.113.7';

  it('blocks on the 5th failure within the window', () => {
    const l = new LoginLimiter();
    const t = 1_000_000;
    for (let i = 0; i < 4; i++) expect(l.fail(ip, t + i)).toBe(false);
    expect(l.retryAfter(ip, t + 4)).toBe(0);
    expect(l.fail(ip, t + 5)).toBe(true);
    expect(l.retryAfter(ip, t + 5)).toBe(300);
  });

  it('unblocks after 5 minutes', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) l.fail(ip, i);
    expect(l.retryAfter(ip, 4 + LIMIT.blockMs - 1)).toBe(1);
    expect(l.retryAfter(ip, 4 + LIMIT.blockMs)).toBe(0);
  });

  it('forgets failures older than the window', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 4; i++) l.fail(ip, i);
    expect(l.fail(ip, LIMIT.windowMs + 10)).toBe(false); // the old 4 expired
  });

  it('is per IP and resets after a successful login', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 4; i++) l.fail(ip, i);
    l.reset(ip);
    expect(l.fail(ip, 10)).toBe(false);
    for (let i = 0; i < 5; i++) l.fail('198.51.100.1', i);
    expect(l.retryAfter(ip, 20)).toBe(0);
  });
});

describe('audit severities', () => {
  it.each([
    ['device_offline', 'crit'],
    ['chain_tamper_detected', 'crit'],
    ['login_failed', 'warning'],
    ['otp_wrong', 'warning'],
    ['forbidden', 'warning'],
    ['device_rejected', 'warning'],
    ['reading_anomaly', 'warning'],
    ['login_blocked', 'warning'],
    ['login_success', 'notice'],
    ['config_changed', 'notice'],
    ['backup_created', 'notice'],
  ])('%s -> %s', (action, severity) => {
    expect(severityFor(action)).toBe(severity);
  });

  it('keeps attacker-controlled values short and on one line', () => {
    expect(clip('a\nb\r\nc', 50)).toBe('a b c');
    expect(clip('x'.repeat(100), 10)).toHaveLength(10);
  });
});
