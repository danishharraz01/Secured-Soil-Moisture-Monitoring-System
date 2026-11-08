/** App notifications (Alert table) - shown in the Flutter app and its local notifications. */
import type { Alert, AlertLevel, AlertType, PrismaClient } from '../db.js';

export interface NewAlert {
  type: AlertType;
  level: AlertLevel;
  message: string;
  simTime?: Date | undefined;
}

export function createAlert(prisma: PrismaClient, alert: NewAlert): Promise<Alert> {
  return prisma.alert.create({
    data: {
      type: alert.type,
      level: alert.level,
      message: alert.message,
      simTime: alert.simTime ?? null,
    },
  });
}

/** Formats a moisture value for messages: one decimal, e.g. "24.3". */
export const mm = (value: number): string => value.toFixed(1);
