/**
 * Constants shared by every part of the system.
 * Values come from the original diploma proposal (celery, soil moisture in mm)
 * and from the security requirements of the rebuilt version.
 */

/** Soil moisture is measured in millimetres of water in the root zone (0-50 mm). */
export const MOISTURE = {
  unit: 'mm',
  min: 0,
  max: 50,
  /** Pump switches ON when moisture is at or below this value. */
  defaultLow: 24.5,
  /** Pump switches OFF when moisture reaches this value (hysteresis, prevents waterlogging). */
  defaultHigh: 32,
} as const;

/** Limits that every threshold change must respect. */
export const THRESHOLD_LIMITS = {
  minLow: 5,
  maxHigh: MOISTURE.max,
  /** Minimum gap between low and high so the pump cannot flap on and off. */
  minGap: 2,
} as const;

/** Tolerance for floating point subtraction, e.g. 30.1 - 28.1 = 1.9999999999999993. */
const EPSILON = 1e-9;

/**
 * Returns true when a low/high threshold pair is safe to use:
 * low >= 5, high <= 50 and high - low >= 2. Non-finite numbers are rejected.
 */
export function validThresholds(low: number, high: number): boolean {
  return (
    Number.isFinite(low) &&
    Number.isFinite(high) &&
    low >= THRESHOLD_LIMITS.minLow &&
    high <= THRESHOLD_LIMITS.maxHigh &&
    high - low >= THRESHOLD_LIMITS.minGap - EPSILON
  );
}

/** Device <-> server protocol. */
export const PROTOCOL = {
  telemetryPath: '/api/device/telemetry',
  headers: {
    deviceId: 'x-device-id',
    timestamp: 'x-timestamp',
    nonce: 'x-nonce',
    signature: 'x-signature',
    serverSignature: 'x-server-signature',
  },
  /** Requests whose timestamp differs from server time by more than this are rejected. */
  timestampSkewMs: 30_000,
  /** Random nonce length in bytes (sent as 32 hex characters). */
  nonceBytes: 16,
  /** Nonces are remembered for this long; anything older is rejected by the timestamp check. */
  nonceTtlMs: 10 * 60_000,
  /** Maximum accepted telemetry request body. */
  maxBodyBytes: 2 * 1024,
} as const;

/** Device IDs: lowercase letters, digits and dashes, 3-32 characters (e.g. "celery-node-01"). */
export const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;

/** Nonces: exactly 16 bytes as lowercase hex. */
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** HMAC-SHA256 signatures: 32 bytes as lowercase hex. */
export const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

/** Timing rules from the four system flows. */
export const TIMING = {
  /** Flow 4: device heartbeat interval (real time). */
  heartbeatMs: 10_000,
  /** Flow 4: device is OFFLINE when no heartbeat has arrived for this long. */
  offlineAfterMs: 30_000,
  /** Flow 4: how often the server checks for offline devices. */
  offlineCheckMs: 5_000,
  /** Flow 2: hard session limit counted from login. */
  sessionMs: 10 * 60_000,
  /** Flow 2: OTP validity. */
  otpMs: 5 * 60_000,
  /** Flow 3/4: minimum gap between SMS/email notifications of the same type. */
  notifyCooldownMs: 2 * 60_000,
  /** Flow 3: how long the red LED stays on after motion. */
  ledOnMs: 60_000,
  /** Flow 2: encrypted cloud backup interval. */
  backupIntervalMs: 10 * 60_000,
} as const;

/**
 * Simulation speed: in demo mode 1 real second = 10 simulated minutes.
 * In real-time mode the device still samples every 10 s (a 1/6-minute step).
 */
export const SIMULATION = {
  stepMinutes: 10,
  demoTickMs: 1_000,
  realtimeTickMs: 10_000,
} as const;
