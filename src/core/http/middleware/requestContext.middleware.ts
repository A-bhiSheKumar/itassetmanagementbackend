import type { Request, Response, NextFunction } from 'express';
import { ulid } from 'ulid';
import { runWithContext } from '../../context/index.js';

/**
 * Opens the ambient request context for the whole request tree.
 *
 * Must be mounted before any route. Tenant and user are filled in later by the
 * auth middleware via patchContext() — the request id has to exist first so
 * that authentication failures are themselves correlatable.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? ulid();

  res.setHeader('X-Request-Id', requestId);

  runWithContext(
    {
      requestId,
      permissions: new Set<string>(),
      actorType: 'user',
    },
    () => next(),
  );
}
