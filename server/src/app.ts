/**
 * Express application (without the HTTPS listener, so tests can drive it
 * directly with supertest).
 *
 *   /api/device/telemetry   device channel (HMAC + AES-GCM, see device/telemetry.ts)
 *   /api/health             public health check
 *   /api/login, /otp, /logout
 *   /api/*                  app API - session required (api/routes.ts)
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { apiRouter } from './api/routes.js';
import { LoginLimiter } from './auth/limiter.js';
import { authRouter } from './auth/routes.js';
import type { AppContext } from './context.js';
import { telemetryRouter } from './device/telemetry.js';

/** Security headers for an API that only ever returns JSON. */
function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.set({
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  next();
}

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false); // req.ip is the real peer address
  app.use(securityHeaders);

  // Request log: method, path, status, duration. Never bodies or headers.
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // originalUrl keeps the full path (routers strip their mount prefix from req.path).
      const path = req.originalUrl.split('?')[0] ?? '';
      // Device traffic (1/s) and app polling (every 3 s) are only logged at debug level.
      const quiet =
        res.statusCode < 400 && (path.startsWith('/api/device/') || req.method === 'GET');
      ctx.logger[quiet ? 'debug' : 'info'](
        { method: req.method, path, status: res.statusCode, ms: Math.round(ms) },
        'request',
      );
    });
    next();
  });

  app.use('/api/device', telemetryRouter(ctx));

  app.get('/api/health', async (_req, res) => {
    let db: 'up' | 'down' = 'up';
    try {
      await ctx.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }
    const s = ctx.syslog.status();
    res.status(db === 'up' ? 200 : 503).json({
      status: db === 'up' ? 'ok' : 'degraded',
      db,
      syslog: s.connected ? 'connected' : `queueing (${s.queued} waiting)`,
      uptime: Math.round((Date.now() - ctx.startedAt) / 1000),
    });
  });

  // ---- App API (JSON only, 10 KB bodies) ---------------------------------------
  app.use('/api', (req, res, next) => {
    const hasBody = Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding');
    if (hasBody && !req.is('application/json')) {
      return void res.status(415).json({ error: 'Content-Type must be application/json' });
    }
    next();
  });
  app.use('/api', express.json({ limit: '10kb', strict: true }));

  const limiter = new LoginLimiter();
  setInterval(() => limiter.prune(), 60_000).unref();
  app.use('/api', authRouter(ctx, limiter));
  app.use('/api', apiRouter(ctx)); // everything below needs a session

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Central error handler: a short message for the client, details only in the server log.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; type?: string };
    if (e.type === 'entity.parse.failed')
      return void res.status(400).json({ error: 'Malformed JSON' });
    if (e.type === 'entity.too.large')
      return void res.status(413).json({ error: 'Request too large' });
    if (e.status && e.status >= 400 && e.status < 500)
      return void res.status(e.status).json({ error: 'Bad request' });
    ctx.logger.error({ err, path: req.path }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
