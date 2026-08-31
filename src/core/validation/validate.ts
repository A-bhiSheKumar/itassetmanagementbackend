import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { ValidationError } from '../errors/index.js';

/**
 * Request validation (docs/04-api-design.md §6).
 *
 * Schemas are STRICT: unknown keys are rejected, not stripped. That single
 * choice kills two bug classes at once —
 *
 *   mass assignment: {"name":"x","role":"owner"} on a profile update never
 *                    reaches a service, because `role` is not in the schema;
 *   NoSQL injection: {"email":{"$ne":null}} fails the string type check before
 *                    it can reach the driver.
 *
 * Parsed output replaces req.body/query/params, so downstream code works with
 * typed, coerced values and never re-reads the raw request.
 */

export interface RequestSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export function validate(schemas: RequestSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const fields: Record<string, string[]> = {};

    for (const source of ['body', 'query', 'params'] as const) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);

      if (!result.success) {
        for (const issue of result.error.issues) {
          const path = issue.path.join('.') || source;
          (fields[path] ??= []).push(issue.message);
        }
        continue;
      }

      // req.query is a getter in Express 5; assigning through defineProperty
      // keeps this working across both major versions.
      Object.defineProperty(req, source, { value: result.data, writable: true });
    }

    if (Object.keys(fields).length > 0) {
      next(new ValidationError('The submitted data is not valid.', fields));
      return;
    }

    next();
  };
}

/** Every request schema should be built from this, so strictness is the default. */
export const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
