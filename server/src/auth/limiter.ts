/**
 * Brute-force protection for login and OTP (per client IP):
 * 5 failed attempts within 5 minutes -> blocked (HTTP 429) for 5 minutes.
 *
 * In-memory is enough for a single server; a multi-instance deployment would
 * keep these counters in Redis or the database.
 */
export const LIMIT = { maxFailures: 5, windowMs: 5 * 60_000, blockMs: 5 * 60_000 } as const;

interface Entry {
  failures: number[];
  blockedUntil: number;
}

export class LoginLimiter {
  private readonly entries = new Map<string, Entry>();

  /** Seconds until the IP may try again, or 0 when it is not blocked. */
  retryAfter(ip: string, now = Date.now()): number {
    const e = this.entries.get(ip);
    if (!e || e.blockedUntil <= now) return 0;
    return Math.ceil((e.blockedUntil - now) / 1000);
  }

  /** Records a failure. Returns true when this failure started a block. */
  fail(ip: string, now = Date.now()): boolean {
    const e = this.entries.get(ip) ?? { failures: [], blockedUntil: 0 };
    e.failures = e.failures.filter((t) => now - t < LIMIT.windowMs);
    e.failures.push(now);
    this.entries.set(ip, e);
    if (e.failures.length >= LIMIT.maxFailures && e.blockedUntil <= now) {
      e.blockedUntil = now + LIMIT.blockMs;
      e.failures = [];
      return true;
    }
    return false;
  }

  /** A completed login clears the IP's failure history. */
  reset(ip: string): void {
    this.entries.delete(ip);
  }

  /** Drops stale entries so the map cannot grow forever. */
  prune(now = Date.now()): void {
    for (const [ip, e] of this.entries) {
      const recent = e.failures.some((t) => now - t < LIMIT.windowMs);
      if (!recent && e.blockedUntil <= now) this.entries.delete(ip);
    }
  }
}
