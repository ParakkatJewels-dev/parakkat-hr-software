import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { healthRouter } from './routes/health';
import { adminRouter } from './routes/admin';
import { exportsRouter } from './routes/exports';

export function createServer(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Entries may be exact origins or wildcards like https://*.vercel.app (matches any subdomain —
  // needed for Vercel preview deploys). Safe because auth is a bearer token the calling page must
  // already hold; CORS here is defence-in-depth, not the security boundary.
  const originAllowed = (origin: string): boolean =>
    env.API_CORS_ORIGINS.some((entry) => {
      if (entry === origin) return true;
      if (!entry.includes('*')) return false;
      const [scheme, host] = entry.split('://');
      const [oScheme, oHost] = origin.split('://');
      return Boolean(scheme === oScheme && host?.startsWith('*.') && oHost?.endsWith(host.slice(1)));
    });

  // Chrome/Edge Private Network Access: an https page calling a localhost/LAN service sends a
  // special preflight that must be answered with this header, or the browser blocks the call
  // even when CORS passes. Must run BEFORE the cors middleware, which ends the preflight.
  app.use((req, _res, next) => {
    if (
      req.method === 'OPTIONS' &&
      req.headers['access-control-request-private-network'] === 'true' &&
      req.headers.origin &&
      originAllowed(req.headers.origin)
    ) {
      _res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    next();
  });

  app.use(
    cors({
      origin: (origin, callback) => {
        // Same-origin/no-origin requests (curl, the health checker, Capacitor's file:// webview)
        // have no Origin header and are allowed through.
        if (!origin) return callback(null, true);
        if (originAllowed(origin)) return callback(null, true);
        return callback(
          Object.assign(new Error(`Origin ${origin} is not in API_CORS_ORIGINS`), { status: 403 })
        );
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '1mb' }));

  // Request logging, minus the noise of health checks polling every few seconds.
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const started = Date.now();
    res.on('finish', () => {
      logger.info(
        { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started },
        'request'
      );
    });
    next();
  });

  app.use(healthRouter);
  app.use(adminRouter);
  app.use(exportsRouter);

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // Deliberate rejections (CORS, scope) carry a status; only genuine surprises log as errors.
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) logger.error({ err }, 'unhandled API error');
    else logger.warn({ msg: err.message, status }, 'request rejected');
    if (res.headersSent) return;
    res.status(status).json({
      error: status === 403 ? 'forbidden' : 'internal_error',
      message: err.message,
    });
  });

  return app;
}
