/**
 * Pump control with hysteresis - runs ON THE DEVICE, so the plant keeps being
 * watered even when the server is unreachable.
 *
 *   moisture <= low   -> relay closes, pump ON
 *   moisture >= high  -> relay opens,  pump OFF
 *   in between        -> keep the current state (no rapid on/off flapping,
 *                        and no waterlogging: watering stops at `high`)
 */
export function decidePump(
  pumpOn: boolean,
  moistureMm: number,
  low: number,
  high: number,
): boolean {
  if (!pumpOn && moistureMm <= low) return true;
  if (pumpOn && moistureMm >= high) return false;
  return pumpOn;
}
