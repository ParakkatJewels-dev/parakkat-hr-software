import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: undefined, // drop pid/hostname — noise under pm2, which stamps its own
  timestamp: pino.stdTimeFunctions.isoTime,
  // Never let a password or token reach the log file.
  redact: {
    paths: [
      'password',
      'req.headers.authorization',
      'headers.authorization',
      'config.headers.Authorization',
      'config.auth.password',
      '*.password',
    ],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
