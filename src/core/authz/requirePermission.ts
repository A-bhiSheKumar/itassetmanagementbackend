import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getContext } from '../context/index.js';
import { PermissionDeniedError, UnauthenticatedError } from '../errors/index.js';
import type { Permission } from './permissions.js';

/**
 * Route-level authorization — "can they do this kind of thing?"
 *
 * Record-level checks ("can they do it to THIS record?") live in each module's
 * policy file, because scoping needs the record. Both layers exist; neither is
 * sufficient alone.
 *
 * Every route carries one of these or an explicit `markPublic()`. A test walks
 * the route table and fails CI on anything that declares neither, so an endpoint
 * cannot ship unguarded by omission.
 */

/** Attached to the handler so the route table test can read it. */
export interface GuardMetadata {
  permission?: Permission;
  public?: boolean;
  authenticatedOnly?: boolean;
}

const GUARD = Symbol.for('itam.guard');

type Guarded = RequestHandler & { [GUARD]?: GuardMetadata };

export function getGuardMetadata(handler: unknown): GuardMetadata | undefined {
  return (handler as Guarded)?.[GUARD];
}

export function requirePermission(permission: Permission): RequestHandler {
  const handler: Guarded = (_req: Request, _res: Response, next: NextFunction) => {
    const ctx = getContext();

    if (!ctx?.userId || !ctx.tenantId) {
      next(new UnauthenticatedError());
      return;
    }

    if (!ctx.permissions.has(permission)) {
      next(new PermissionDeniedError(permission));
      return;
    }

    next();
  };

  handler[GUARD] = { permission };
  return handler;
}

/** Authenticated, but no specific permission — /me, tenant switching, logout. */
export function requireAuth(): RequestHandler {
  const handler: Guarded = (_req: Request, _res: Response, next: NextFunction) => {
    const ctx = getContext();
    if (!ctx?.userId) {
      next(new UnauthenticatedError());
      return;
    }
    next();
  };

  handler[GUARD] = { authenticatedOnly: true };
  return handler;
}

/**
 * Explicitly public. Deliberately verbose — an unauthenticated endpoint should
 * be a decision someone made, not a line someone forgot.
 */
export function markPublic(): RequestHandler {
  const handler: Guarded = (_req, _res, next) => next();
  handler[GUARD] = { public: true };
  return handler;
}
