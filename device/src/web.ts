/**
 * Virtual Garden web page (http://localhost:4000) - a live view of the
 * simulated hardware with a few controls.
 *
 * It is a local control panel, so it is locked down to this computer:
 *  - listens on 127.0.0.1 only (not reachable from the LAN)
 *  - Host header must be localhost/127.0.0.1 (blocks DNS-rebinding attacks)
 *  - control requests must be JSON with a same-origin Origin header (blocks
 *    other websites from posting to it - CSRF)
 *  - strict Content-Security-Policy: no inline scripts, same-origin only
 */
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { MOISTURE } from '@soil/shared';
import { z } from 'zod';
import type { DeviceSimulator, DeviceState, LogEntry } from './simulator.js';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');

const moistureSchema = z.object({ value: z.number().min(MOISTURE.min).max(MOISTURE.max) }).strict();
const disconnectSchema = z.object({ enabled: z.boolean() }).strict();
const speedSchema = z.object({ speed: z.enum(['demo', 'realtime']) }).strict();
const emptySchema = z.object({}).strict();

export function createWebApp(device: DeviceSimulator, port: number): express.Express {
  const app = express();
  app.disable('x-powered-by');
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!allowedHosts.has(req.headers.host ?? '')) {
      res.status(403).type('text/plain').send('Forbidden host');
      return;
    }
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    next();
  });

  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

  app.get('/api/state', (_req, res) => {
    res.json({ state: device.getState(), log: device.getLog().slice(-60) });
  });

  // ---- Live updates: Server-Sent Events ------------------------------------
  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send('snapshot', { state: device.getState(), log: device.getLog().slice(-60) });

    const onState = (s: DeviceState): void => send('state', s);
    const onLog = (e: LogEntry): void => send('log', e);
    device.on('state', onState);
    device.on('log', onLog);
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      device.off('state', onState);
      device.off('log', onLog);
    });
  });

  // ---- Controls -------------------------------------------------------------
  const control = express.Router();
  control.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.has(origin)) {
      res.status(403).json({ error: 'Cross-origin request blocked' });
      return;
    }
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Content-Type must be application/json' });
      return;
    }
    next();
  });
  control.use(express.json({ limit: '1kb', strict: true }));

  control.post('/moisture', (req, res) => {
    const body = moistureSchema.safeParse(req.body);
    if (!body.success)
      return void res.status(400).json({ error: 'Expected exactly {"value": <0-50 mm>}' });
    device.setMoisture(body.data.value);
    res.json({ ok: true });
  });
  control.post('/motion', (req, res) => {
    if (!emptySchema.safeParse(req.body).success)
      return void res.status(400).json({ error: 'no body expected' });
    device.triggerMotion('button');
    res.json({ ok: true });
  });
  control.post('/disconnect', (req, res) => {
    const body = disconnectSchema.safeParse(req.body);
    if (!body.success)
      return void res.status(400).json({ error: 'Expected exactly {"enabled": true|false}' });
    device.setDisconnected(body.data.enabled);
    res.json({ ok: true });
  });
  control.post('/speed', (req, res) => {
    const body = speedSchema.safeParse(req.body);
    if (!body.success)
      return void res.status(400).json({ error: 'Expected exactly {"speed": "demo"|"realtime"}' });
    device.setSpeed(body.data.speed);
    res.json({ ok: true });
  });
  app.use('/api/control', control);

  // ---- Errors: never leak stack traces --------------------------------------
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status;
    res.status(status && status >= 400 && status < 500 ? status : 500).json({
      error:
        status === 413
          ? 'Request too large'
          : status && status < 500
            ? 'Bad request'
            : 'Internal error',
    });
  });

  return app;
}
