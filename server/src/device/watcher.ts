/**
 * Flow 4 - device disconnection. Every 5 s: a device marked online whose last
 * heartbeat is older than 30 s becomes OFFLINE -> critical alert, syslog CRIT,
 * SMS + email to the owner. Also purges nonces older than their 10 min TTL.
 */
import { PROTOCOL, TIMING } from '@soil/shared';
import type { AppContext } from '../context.js';
import { createAlert } from '../services/alerts.js';
import { estimateSimNow } from '../services/simclock.js';

export class DeviceWatcher {
  private offlineTimer: NodeJS.Timeout | undefined;
  private nonceTimer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    this.offlineTimer = setInterval(
      () => void this.safe(() => this.checkOffline()),
      TIMING.offlineCheckMs,
    );
    this.nonceTimer = setInterval(() => void this.safe(() => this.purgeNonces()), 60_000);
  }

  stop(): void {
    clearInterval(this.offlineTimer);
    clearInterval(this.nonceTimer);
  }

  private async safe(task: () => Promise<unknown>): Promise<void> {
    if (this.running) return; // never overlap runs
    this.running = true;
    try {
      await task();
    } catch (e) {
      this.ctx.logger.error({ err: e }, 'Device watcher task failed');
    } finally {
      this.running = false;
    }
  }

  /** Marks silent devices offline. Returns the IDs that just went offline. */
  async checkOffline(now = new Date()): Promise<string[]> {
    const cutoff = new Date(now.getTime() - TIMING.offlineAfterMs);
    const silent = await this.ctx.prisma.device.findMany({
      where: { online: true, lastSeenAt: { lt: cutoff } },
      select: { id: true, lastSeenAt: true },
    });

    const wentOffline: string[] = [];
    for (const d of silent) {
      // Conditional update: if a heartbeat arrived in the meantime, nothing happens.
      const changed = await this.ctx.prisma.device.updateMany({
        where: { id: d.id, online: true, lastSeenAt: { lt: cutoff } },
        data: { online: false },
      });
      if (changed.count === 0) continue;
      wentOffline.push(d.id);

      const seconds = Math.round(
        (now.getTime() - (d.lastSeenAt?.getTime() ?? now.getTime())) / 1000,
      );
      const message = `Device ${d.id} disconnected`;
      await createAlert(this.ctx.prisma, {
        type: 'offline',
        level: 'critical',
        message,
        // Device (simulated) time when it went silent - used for "offline minutes" in reports.
        simTime: await estimateSimNow(
          this.ctx.prisma,
          this.ctx.simSpeedFactor,
          d.lastSeenAt ?? now,
        ),
      });
      await this.ctx.audit.record({
        actor: d.id,
        action: 'device_offline',
        detail: `${message} - no heartbeat for ${seconds} s`,
        msgId: 'device',
        severity: 'crit',
      });
      await this.ctx.notifier.notify(
        'offline',
        `Device ${d.id} disconnected`,
        `Soil Monitor: device ${d.id} has not sent a heartbeat for ${seconds} s (since ${d.lastSeenAt?.toLocaleString() ?? 'unknown'}). The pump keeps running on the device, but you are not receiving data.`,
      );
    }
    return wentOffline;
  }

  async purgeNonces(now = new Date()): Promise<number> {
    const { count } = await this.ctx.prisma.nonce.deleteMany({
      where: { seenAt: { lt: new Date(now.getTime() - PROTOCOL.nonceTtlMs) } },
    });
    // Expired sessions and OTP challenges are useless - remove them too.
    await this.ctx.prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.ctx.prisma.otpChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
    return count;
  }
}
