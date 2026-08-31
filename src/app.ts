import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { env } from './config/index.js';
import {
  requestContextMiddleware,
  errorHandler,
  notFoundHandler,
  authenticate,
} from './core/http/index.js';
import { permissionResolver } from './modules/identity/index.js';
import { apiRouter } from './routes.js';
import { registerEventSubscribers } from './subscribers.js';

export function createApp(): Express {
  // Idempotent, and here as well as in the entrypoints so that anything which
  // builds an app — tests included — gets a working event spine.
  registerEventSubscribers();

  const app = express();

  // Behind a load balancer, so req.ip reflects the client rather than the proxy.
  // Rate limiting and audit logging both depend on this being correct.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      // helmet defaults X-Frame-Options to SAMEORIGIN. Nothing in this app is
      // ever framed, so DENY — and CSP frame-ancestors above covers browsers
      // that prefer it. Belt and braces, because clickjacking a "Retire asset"
      // button is a real attack.
      frameguard: { action: 'deny' },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  app.use(
    cors({
      // An explicit allowlist — never '*' and never a reflected origin, both of
      // which defeat the point when credentials are enabled.
      origin: env.CORS_ORIGINS,
      credentials: true,
      maxAge: 86_400,
    }),
  );

  app.use(compression());
  app.use(cookieParser());

  /**
   * Body parsing skips the raw-upload endpoint.
   *
   * The presigned PUT reads the request stream itself. A body parser that
   * matched first would drain it and the handler would store an empty file —
   * which is exactly what happened with a client that sent no explicit
   * Content-Type, because `urlencoded` claims form-encoded by default. An
   * upload must not depend on the client choosing a particular header.
   */
  const isRawUpload = (req: { method?: string; url?: string }): boolean =>
    req.method === 'PUT' && (req.url ?? '').startsWith('/api/v1/documents/upload');

  app.use(
    express.json({
      limit: '1mb',
      type: (req) => !isRawUpload(req) && /[/+]json/.test(req.headers['content-type'] ?? ''),
    }),
  );

  app.use(
    express.urlencoded({
      extended: false,
      limit: '1mb',
      type: (req) =>
        !isRawUpload(req) &&
        (req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded'),
    }),
  );

  // Opens the ambient context. Must precede every route.
  app.use(requestContextMiddleware);

  // Populates the context from the Authorization header when one is present.
  // Deliberately does NOT reject anonymous requests — enforcement belongs to
  // each route's guard, so public and guarded routes share one code path.
  app.use(authenticate(permissionResolver));

  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
