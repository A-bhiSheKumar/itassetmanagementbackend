import { getContext } from '../context/index.js';
import { logger } from '../logging/index.js';
import { isProduction } from '../../config/index.js';

/**
 * Error reporting behind an interface.
 *
 * Sentry is the intended destination, but wiring it needs a DSN and an account,
 * and the shape of the problem does not. What matters architecturally is that
 * there is exactly ONE place errors are reported from, that it carries tenant
 * and request context, and that it never throws into the caller — an error
 * reporter that can fail a request is worse than no error reporter.
 *
 * Swapping in Sentry is `setErrorReporter(new SentryReporter(dsn))` and nothing
 * above this file changes.
 */

export interface ErrorContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
  route?: string;
  /** Anything else worth having in the report. */
  extra?: Record<string, unknown>;
}

export interface ErrorReporter {
  readonly name: string;
  report(error: unknown, context: ErrorContext): void;
}

/**
 * Logs and counts, instead of sending.
 *
 * Not a no-op: the counts are readable at /metrics, so error RATE is observable
 * even before a reporting service exists. Rate is what you alert on; individual
 * stack traces are what you debug with afterwards.
 */
export class LoggingErrorReporter implements ErrorReporter {
  readonly name = 'logging';

  private readonly counts = new Map<string, number>();
  private total = 0;

  report(error: unknown, context: ErrorContext): void {
    this.total += 1;

    const key = error instanceof Error ? error.name : 'Unknown';
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);

    logger.error({ err: error, ...context }, 'Reported error');
  }

  snapshot(): { total: number; byType: Record<string, number> } {
    return { total: this.total, byType: Object.fromEntries(this.counts) };
  }

  reset(): void {
    this.counts.clear();
    this.total = 0;
  }
}

let reporter: ErrorReporter = new LoggingErrorReporter();

export function setErrorReporter(next: ErrorReporter): void {
  reporter = next;
  logger.info({ reporter: next.name }, 'Error reporter configured');
}

export function getErrorReporter(): ErrorReporter {
  return reporter;
}

/**
 * Reports an error, enriched from the ambient request context.
 *
 * Deliberately swallows its own failures. An exception thrown from inside error
 * reporting replaces a useful 500 with a confusing one, and does it precisely
 * when things are already going wrong.
 */
export function reportError(error: unknown, extra?: Record<string, unknown>): void {
  try {
    const ctx = getContext();

    reporter.report(error, {
      requestId: ctx?.requestId,
      tenantId: ctx?.tenantId,
      userId: ctx?.userId,
      extra,
    });
  } catch (reportingFailure) {
    logger.error({ err: reportingFailure }, 'Error reporter itself failed');
  }
}

/**
 * Warns once at boot if nothing real is configured in production.
 *
 * Not fatal — the application works perfectly well without error reporting, and
 * refusing to start would be a worse outcome than running unmonitored. But it
 * should never be a surprise.
 */
export function warnIfUnconfigured(): void {
  if (isProduction && reporter.name === 'logging') {
    logger.warn(
      'No error reporting service is configured. Errors are logged and counted at ' +
        '/metrics, but nothing is being sent anywhere.',
    );
  }
}
