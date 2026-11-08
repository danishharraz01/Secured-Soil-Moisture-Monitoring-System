/**
 * zod schemas for decrypted device payloads. `.strict()` rejects unknown
 * fields, and every value has a type, range and size limit.
 */
import { MOISTURE } from '@soil/shared';
import { z } from 'zod';

/** ISO 8601 UTC time between 2020 and 2100 (demo mode runs the clock fast). */
const simTime = z.iso.datetime({ offset: false }).refine((v) => {
  const t = Date.parse(v);
  return t >= Date.UTC(2020, 0, 1) && t < Date.UTC(2100, 0, 1);
}, 'simTime out of range');

export const readingSchema = z
  .object({
    type: z.literal('reading'),
    moistureMm: z.number().min(MOISTURE.min).max(MOISTURE.max),
    pumpOn: z.boolean(),
    /** One reading covers at most 10 simulated minutes of pumping (~45 ml). */
    waterMl: z.number().int().min(0).max(1000),
    simTime,
  })
  .strict();

export const heartbeatSchema = z
  .object({
    type: z.literal('heartbeat'),
    uptime: z
      .number()
      .int()
      .min(0)
      .max(10 * 365 * 24 * 3600),
  })
  .strict();

export const motionSchema = z
  .object({
    type: z.literal('motion'),
    sensor: z.string().regex(/^[a-z0-9-]{1,16}$/),
    simTime,
  })
  .strict();

export const devicePayloadSchema = z.discriminatedUnion('type', [
  readingSchema,
  heartbeatSchema,
  motionSchema,
]);

export type ReadingInput = z.infer<typeof readingSchema>;
export type MotionInput = z.infer<typeof motionSchema>;

/** Short, safe description of the first validation problem (no input values echoed). */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid payload';
  const where = issue.path.length ? issue.path.join('.') : 'payload';
  return `${where}: ${issue.message}`.slice(0, 120);
}
