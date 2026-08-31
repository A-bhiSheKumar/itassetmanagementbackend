import type { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError, DuplicateValueError, ErrorCode, ValidationError } from '../../errors/index.js';
import { logger } from '../../logging/index.js';
import { getContext } from '../../context/index.js';
import { isProduction } from '../../../config/index.js';

/**
 * The single exit point for every error.
 *
 * Trusted errors (AppError) are rendered to the client. Everything else is a
 * bug: logged with a stack, and rendered as a bare 500. That asymmetry is what
 * keeps stack traces and driver messages — a raw E11000 string discloses
 * collection and index names — out of API responses.
 */

interface MongoDuplicateKeyError extends Error {
  code: number;
  keyPattern?: Record<string, number>;
  keyValue?: Record<string, unknown>;
}

interface BodyParserError extends SyntaxError {
  status?: number;
  type?: string;
}

function translate(err: unknown): AppError {
  if (err instanceof AppError) return err;

  // A malformed JSON body is the CLIENT's mistake, not ours. Left untranslated
  // it falls through to the 500 branch below and — outside production — the
  // response carries a stack trace naming our dependency paths.
  if (err instanceof SyntaxError && 'body' in err) {
    const parseError = err as BodyParserError;
    return new AppError(
      400,
      ErrorCode.VALIDATION_FAILED,
      'The request body is not valid JSON.',
      { expected: true, details: { type: parseError.type } },
    );
  }

  // Body larger than the configured limit.
  if ((err as BodyParserError)?.type === 'entity.too.large') {
    return new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'That request is too large.', {
      expected: true,
    });
  }

  if (err instanceof ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      (fields[key] ??= []).push(issue.message);
    }
    return new ValidationError('The submitted data is not valid.', fields);
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const fields: Record<string, string[]> = {};
    for (const [path, e] of Object.entries(err.errors)) {
      (fields[path] ??= []).push(e.message);
    }
    return new ValidationError('The submitted data is not valid.', fields);
  }

  if (err instanceof mongoose.Error.CastError) {
    return new ValidationError('The submitted data is not valid.', {
      [err.path]: [`Expected a valid ${err.kind}.`],
    });
  }

  // E11000. The partial unique index on active assignments surfaces here too —
  // the assignment service catches it first and raises AssetAlreadyAssignedError,
  // which is why that case carries a useful message and this one is generic.
  const mongoErr = err as MongoDuplicateKeyError;
  if (mongoErr?.code === 11000) {
    const keys = Object.keys(mongoErr.keyPattern ?? {});
    // Name the field the user can actually act on. tenantId and deletedAt are
    // present in almost every compound unique index and mean nothing to a
    // client — but if they are ALL there is, say so rather than "value",
    // because that case is a bug on our side and needs to be diagnosable.
    const field = keys.find((k) => k !== 'tenantId' && k !== 'deletedAt') ?? keys[0] ?? 'value';
    logger.warn(
      { keyPattern: mongoErr.keyPattern, keyValue: mongoErr.keyValue },
      'Duplicate key rejected',
    );
    return new DuplicateValueError(field, mongoErr.keyValue?.[field]);
  }

  return new AppError(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong on our end.', {
    cause: err,
    expected: false,
  });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = translate(err);

  if (appError.expected) {
    logger.info(
      { code: appError.code, status: appError.status },
      `Handled: ${appError.message}`,
    );
  } else {
    // Unexpected errors get the original throw, not the translated one — the
    // stack of the wrapper is useless for debugging.
    logger.error({ err, code: appError.code }, 'Unhandled error');
  }

  res.status(appError.status).json({
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
      ...(appError.fields ? { fields: appError.fields } : {}),
      // Stacks only ever leave the process in development — and it must be the
      // ORIGINAL error's stack. The translated AppError's stack points at this
      // file, which tells a developer nothing about where the failure was.
      ...(!isProduction && !appError.expected
        ? { stack: (appError.cause as Error | undefined)?.stack ?? appError.stack }
        : {}),
    },
    meta: { requestId: getContext()?.requestId ?? 'unknown' },
  });
}
