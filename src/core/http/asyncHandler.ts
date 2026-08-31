import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Express 4 does not forward rejected promises to error middleware, so an
 * unhandled async throw in a controller becomes a hung request rather than a
 * 500. Every async route handler goes through this.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
