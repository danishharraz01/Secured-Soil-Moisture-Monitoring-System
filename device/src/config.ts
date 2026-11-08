/**
 * Device configuration: the provisioning file written by `npm run setup`
 * (device/device.json) plus a few environment variables.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { deriveDeviceKeys, DEVICE_ID_PATTERN, type DeviceKeys } from '@soil/shared';
import { z } from 'zod';

const DEVICE_DIR = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(DEVICE_DIR, '..');

export type Speed = 'demo' | 'realtime';

export interface DeviceConfig {
  deviceId: string;
  keys: DeviceKeys;
  serverUrl: URL;
  /** The ONLY certificate the device trusts (pinning). */
  serverCertPem: string;
  /** Server Ed25519 key; replies that change thresholds must be signed with it. */
  serverPublicKey: KeyObject;
  /** The Virtual Garden page listens on 127.0.0.1 only. */
  webHost: string;
  webPort: number;
  speed: Speed;
  motionChance: number;
}

const deviceFileSchema = z.object({
  deviceId: z.string().regex(DEVICE_ID_PATTERN),
  secret: z.string().min(1),
  serverUrl: z.string(),
  serverCertPath: z.string(),
  serverSigningPublicKey: z.string().includes('BEGIN PUBLIC KEY'),
});

const envSchema = z.object({
  DEVICE_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DEVICE_SERVER_URL: z.string().optional(),
  SIM_SPEED: z.enum(['demo', 'realtime']).default('demo'),
  MOTION_CHANCE: z.coerce.number().min(0).max(1).default(0.002),
});

export function loadDeviceConfig(): DeviceConfig {
  const envFile = path.join(REPO_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const file = path.join(DEVICE_DIR, 'device.json');
  if (!existsSync(file)) {
    throw new Error('device/device.json not found - run "npm run setup" first');
  }
  const device = deviceFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const env = envSchema.parse(process.env);

  const secret = Buffer.from(device.secret, 'base64');
  if (secret.length !== 32) throw new Error('device.json: secret must be 256 bits');

  // Empty DEVICE_SERVER_URL in .env means "use the provisioned URL".
  const serverUrl = new URL(env.DEVICE_SERVER_URL || device.serverUrl);
  if (serverUrl.protocol !== 'https:') {
    throw new Error(`Server URL must use https:// (got ${serverUrl.protocol}//)`);
  }

  return {
    deviceId: device.deviceId,
    keys: deriveDeviceKeys(secret),
    serverUrl,
    serverCertPem: readFileSync(path.resolve(DEVICE_DIR, device.serverCertPath), 'utf8'),
    serverPublicKey: createPublicKey(device.serverSigningPublicKey),
    webHost: '127.0.0.1',
    webPort: env.DEVICE_PORT,
    speed: env.SIM_SPEED,
    motionChance: env.MOTION_CHANCE,
  };
}
