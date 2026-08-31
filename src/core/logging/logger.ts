import pino from 'pino';
import { env, isProduction, isTest } from '../../config/index.js';
import { getContext } from '../context/index.js';

/**
 * Structured logging.
 *
 * Every line carries requestId, tenantId and userId via the mixin below. The
 * tenantId in particular is what makes customer-specific debugging possible at
 * all — without it, a production log is one undifferentiated stream.
 */
export const logger = pino({
  // Silent under test unless ITAM_TEST_LOGS is set — a failing suite that
  // cannot explain itself costs more than the noise.
  level: isTest && !process.env.ITAM_TEST_LOGS ? 'silent' : env.LOG_LEVEL,

  // Resolved per log call from the ambient context, so callers never pass it.
  mixin() {
    const ctx = getContext();
    if (!ctx) return {};
    return {
      requestId: ctx.requestId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    };
  },

  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.tokenHash',
      '*.refreshToken',
      '*.accessToken',
      '*.secret',
      'body.password',
      'body.currentPassword',
      'body.newPassword',
    ],
    censor: '[redacted]',
  },

  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }),
});

export type Logger = typeof logger;
