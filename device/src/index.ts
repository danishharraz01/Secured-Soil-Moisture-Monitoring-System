/**
 * Virtual IoT device entry point: NodeMCU + soil moisture sensor + relay +
 * water pump + sprinkler + PIR motion sensor + LED, plus the Virtual Garden
 * page on http://localhost:4000.
 */
import { loadDeviceConfig } from './config.js';
import { ServerLink } from './link.js';
import { DeviceSimulator } from './simulator.js';
import { createWebApp } from './web.js';

const config = loadDeviceConfig();

const link = new ServerLink({
  deviceId: config.deviceId,
  keys: config.keys,
  serverUrl: config.serverUrl,
  serverCertPem: config.serverCertPem,
  serverPublicKey: config.serverPublicKey,
});

const device = new DeviceSimulator({
  deviceId: config.deviceId,
  link,
  speed: config.speed,
  motionChance: config.motionChance,
});

const server = createWebApp(device, config.webPort).listen(config.webPort, config.webHost, () => {
  console.log(`Virtual Garden:  http://localhost:${config.webPort}`);
  console.log(
    `Device ${config.deviceId} -> ${config.serverUrl.origin} (certificate pinned, AES-128-GCM + HMAC-SHA256)`,
  );
  device.start();
});

function shutdown(): void {
  console.log('Device shutting down...');
  device.stop();
  link.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
