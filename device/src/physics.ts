/**
 * Soil physics for one celery pot. Moisture is millimetres of water held in
 * the root zone (0-50 mm). All rates are "per 10 simulated minutes" and are
 * scaled linearly for other step sizes.
 */
import { MOISTURE } from '@soil/shared';

/** Random source returning [0, 1). Injected so tests are deterministic. */
export type Rng = () => number;

export const PHYSICS = {
  /** Daytime (sun, higher evaporation) is 09:00-17:59 simulated time. */
  dayStartHour: 9,
  dayEndHour: 18,
  /** Evaporation per 10 min: base + rand * random. */
  dayEvaporationMm: 0.36,
  nightEvaporationMm: 0.14,
  evaporationRandomMm: 0.12,
  /** Water added by the pump per 10 min of running. */
  pumpMm: 1.3,
  /** Pump flow: 1.3 mm over a ~20 cm pot (~314 cm2) is ~41 ml, plus a little run-off. */
  pumpMlPer10Min: 45,
  /** Sensor noise: +-0.12 mm (uniform). */
  sensorNoiseMm: 0.12,
} as const;

const clampMoisture = (mm: number): number => Math.min(MOISTURE.max, Math.max(MOISTURE.min, mm));

/** Two decimals is far below the sensor noise; keeps payloads small and readable. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function isDaytime(simTime: Date): boolean {
  const h = simTime.getHours();
  return h >= PHYSICS.dayStartHour && h < PHYSICS.dayEndHour;
}

/** Evaporation (mm) over `minutes` starting at `simTime`. */
export function evaporationMm(simTime: Date, minutes: number, rng: Rng): number {
  const base = isDaytime(simTime) ? PHYSICS.dayEvaporationMm : PHYSICS.nightEvaporationMm;
  return (base + rng() * PHYSICS.evaporationRandomMm) * (minutes / 10);
}

export interface SoilStep {
  /** True soil moisture after the step (mm). */
  moistureMm: number;
  /** Water pumped during the step (ml, fractional). */
  waterMl: number;
}

/** Advances the true soil moisture by `minutes`. */
export function advanceSoil(
  moistureMm: number,
  pumpOn: boolean,
  simTime: Date,
  minutes: number,
  rng: Rng,
): SoilStep {
  const added = pumpOn ? PHYSICS.pumpMm * (minutes / 10) : 0;
  return {
    moistureMm: clampMoisture(moistureMm - evaporationMm(simTime, minutes, rng) + added),
    waterMl: pumpOn ? PHYSICS.pumpMlPer10Min * (minutes / 10) : 0,
  };
}

/** What the capacitive sensor reports: true value +- noise, clamped to 0-50 mm. */
export function sensorRead(trueMm: number, rng: Rng): number {
  return round2(clampMoisture(trueMm + (rng() * 2 - 1) * PHYSICS.sensorNoiseMm));
}
