import { ErrorCode, type ErrorCodeValue } from './errorCodes.js';

export type FieldErrors = Record<string, string[]>;

export interface AppErrorOptions {
  details?: Record<string, unknown>;
  fields?: FieldErrors;
  cause?: unknown;
  /** Suppresses Sentry reporting for errors that are expected user outcomes. */
  expected?: boolean;
}

/**
 * Base class for every error the API deliberately produces.
 *
 * The error middleware trusts `status`, `code`, `message`, `details` and
 * `fields` on an AppError and sends them to the client. Anything that is NOT an
 * AppError is treated as a bug: logged with a stack, reported, and rendered to
 * the client as a bare 500. That asymmetry is what keeps driver messages and
 * stack traces out of responses.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCodeValue;
  readonly details?: Record<string, unknown>;
  readonly fields?: FieldErrors;
  readonly expected: boolean;

  constructor(
    status: number,
    code: ErrorCodeValue,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.fields = options.fields;
    this.expected = options.expected ?? status < 500;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The submitted data is not valid.', fields?: FieldErrors) {
    super(422, ErrorCode.VALIDATION_FAILED, message, { fields });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'You need to sign in to do that.') {
    super(401, ErrorCode.UNAUTHENTICATED, message);
  }
}

export class TokenExpiredError extends AppError {
  constructor(message = 'Your session has expired.') {
    super(401, ErrorCode.TOKEN_EXPIRED, message);
  }
}

export class PermissionDeniedError extends AppError {
  constructor(permission?: string) {
    super(403, ErrorCode.PERMISSION_DENIED, "You don't have permission to do that.", {
      details: permission ? { requiredPermission: permission } : undefined,
    });
  }
}

/**
 * Also used for resources belonging to another tenant (ADR-015).
 *
 * A 403 would confirm the resource exists, turning every endpoint into an
 * enumeration oracle. Foreign resources are indistinguishable from missing ones.
 */
export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, ErrorCode.NOT_FOUND, `${resource} not found.`);
  }
}

export class DuplicateValueError extends AppError {
  constructor(field: string, value?: unknown) {
    super(409, ErrorCode.DUPLICATE_VALUE, `That ${field} is already in use.`, {
      details: { field, value },
      fields: { [field]: [`Already in use.`] },
    });
  }
}

export class AssetAlreadyAssignedError extends AppError {
  constructor(details: { assetId: string; assignmentId?: string; assigneeId?: string }) {
    super(
      409,
      ErrorCode.ASSET_ALREADY_ASSIGNED,
      'This asset is already assigned. Transfer it instead of assigning it again.',
      { details },
    );
  }
}

export class StaleWriteError extends AppError {
  constructor() {
    super(
      409,
      ErrorCode.STALE_WRITE,
      'Someone else changed this record while you were editing. Reload and try again.',
    );
  }
}

export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string, reason?: string) {
    super(422, ErrorCode.INVALID_TRANSITION, reason ?? `Cannot move from ${from} to ${to}.`, {
      details: { from, to },
    });
  }
}

export class EntitlementExceededError extends AppError {
  constructor(resource: string, limit: number, current: number) {
    super(
      402,
      ErrorCode.ENTITLEMENT_EXCEEDED,
      `Your plan allows ${limit} ${resource}. You have ${current}.`,
      { details: { resource, limit, current } },
    );
  }
}

export class SubscriptionInactiveError extends AppError {
  constructor(status: string) {
    super(
      402,
      ErrorCode.SUBSCRIPTION_INACTIVE,
      'Your subscription is not active. You can still read and export your data.',
      { details: { subscriptionStatus: status } },
    );
  }
}

export class ResourceInUseError extends AppError {
  constructor(resource: string, references: Array<{ type: string; count: number }>) {
    const total = references.reduce((n, r) => n + r.count, 0);
    super(
      409,
      ErrorCode.RESOURCE_IN_USE,
      `This ${resource} is used by ${total} record${total === 1 ? '' : 's'}. Reassign them first, or archive it instead.`,
      { details: { references } },
    );
  }
}

export class LastOwnerError extends AppError {
  constructor() {
    super(
      409,
      ErrorCode.LAST_OWNER,
      'An organisation must always have an owner. Transfer ownership first.',
    );
  }
}

export class InternalError extends AppError {
  constructor(message = 'Something went wrong on our end.', cause?: unknown) {
    super(500, ErrorCode.INTERNAL_ERROR, message, { cause, expected: false });
  }
}

/**
 * Raised by the tenant-scope plugin when a query runs with no tenant in context.
 *
 * This is always a wiring bug and is deliberately loud: the alternative — a
 * query that quietly returns every tenant's rows — is the failure this whole
 * architecture exists to prevent.
 */
export class MissingTenantScopeError extends AppError {
  constructor(modelName: string, operation: string) {
    super(
      500,
      ErrorCode.INTERNAL_ERROR,
      `Query on ${modelName} (${operation}) ran without a tenant in context. ` +
        'Wrap the call in runWithContext(), or mark the model as global.',
      { expected: false },
    );
  }
}

/** Raised when a document's tenantId disagrees with the ambient context. */
export class CrossTenantWriteError extends AppError {
  constructor(modelName: string, documentTenantId: string, contextTenantId: string) {
    super(
      500,
      ErrorCode.INTERNAL_ERROR,
      `Refused a cross-tenant write on ${modelName}: document belongs to ` +
        `${documentTenantId} but the request is scoped to ${contextTenantId}.`,
      { expected: false },
    );
  }
}
