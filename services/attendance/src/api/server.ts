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

  app.use(
    cors({
      origin: (origin, callback) => {
        // Same-origin/no-origin requests (curl, the health checker, Capacitor's file:// webview)
        // have no Origin header and are allowed through.
        if (!origin) return callback(null, true);
        if (env.API_CORS_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed`));
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
    logger.error({ err }, 'unhandled API error');
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error', message: err.message });
  });

  return app;
}
