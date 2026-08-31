import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ambient request context — layer 1 of tenant isolation (ADR-002).
 *
 * Carries tenant, actor and permissions through every async call without being
 * threaded as a parameter. Services and repositories read it directly, which is
 * what makes the tenant filter in db/plugins/tenantScope.plugin.ts automatic
 * rather than something a developer has to remember.
 *
 * The important property: a missing context is an ERROR, not an empty filter.
 * See requireTenantId() below.
 */

export type ActorType = 'user' | 'system' | 'job' | 'integration' | 'import';

export interface RequestContext {
  /** Correlates the HTTP response, every log line and the Sentry event. */
  requestId: string;

  /** Absent for unauthenticated requests and for platform-level operations. */
  tenantId?: string;

  userId?: string;
  membershipId?: string;

  /** Effective permission strings, resolved once per request. */
  permissions: ReadonlySet<string>;

  /** Department/location scoping for scoped roles. */
  scope?: {
    type: 'all' | 'department' | 'location';
    departmentIds?: string[];
    locationIds?: string[];
  };

  actorType: ActorType;

  /**
   * Ids of outbox events this request has emitted.
   *
   * flushOutbox() delivers exactly these after the commit, so the request's own
   * timeline and audit entries exist by the time it responds — without scanning
   * the global queue, which would tie every write's latency to the backlog.
   */
  pendingEventIds?: string[];

  /**
   * Set only inside withoutTenantScope(). The tenant plugin checks this before
   * refusing an un-scoped query, so the escape hatch is explicit and greppable.
   */
  tenantScopeBypass?: { reason: string };
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `fn` with `ctx` as the ambient context for the whole async tree.
 *
 * ── The lazy-query trap ───────────────────────────────────────────────────
 * A Mongoose Query is lazy: `Model.find()` builds it, `.then()`/`.exec()` runs
 * it. So this is WRONG —
 *
 *     await runWithContext(ctx, () => Asset.find({}))   // ✗
 *
 * because the query is merely constructed inside the context and executed
 * outside it, by which point the tenant filter has nothing to read and the
 * plugin throws MissingTenantScopeError.
 *
 * Awaiting inside the callback fixes it, because the continuation is created
 * within the context:
 *
 *     await runWithContext(ctx, async () => Asset.find({}))   // ✓
 *
 * Request handlers are safe automatically: the Express middleware runs the
 * whole handler chain inside the context, so every await downstream inherits
 * it. runAsSync/runAsSystem/withoutTenantScope below await internally, so
 * callers of those cannot get this wrong.
 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The current context, or undefined outside a request/job. */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getContextOrThrow(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      'No request context. Every request and job must run inside runWithContext(). ' +
        'This is a wiring bug, not a user error.',
    );
  }
  return ctx;
}

export function getTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

export function getActorId(): string | undefined {
  return storage.getStore()?.userId;
}

/**
 * Mutates the current context in place.
 *
 * Used by auth middleware, which resolves the tenant AFTER the context is
 * created (the request id has to exist before authentication can be logged).
 */
export function patchContext(patch: Partial<RequestContext>): void {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('patchContext() called outside a request context.');
  Object.assign(ctx, patch);
}

/**
 * The only sanctioned way to run a cross-tenant query.
 *
 * Restricted by eslint to src/modules/platform/. Requires a reason, which is
 * written to the platform audit log by the caller. If you find yourself wanting
 * this outside platform tooling, the query is almost certainly a bug.
 */
export async function withoutTenantScope<T>(
  reason: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const parent = getContextOrThrow();
  const bypassed: RequestContext = { ...parent, tenantScopeBypass: { reason } };
  // Awaits INSIDE the scope — see the lazy-query note on runWithContext().
  return storage.run(bypassed, async () => fn());
}

/**
 * Runs `fn` in a synthetic context — for jobs, migrations and seeds.
 *
 * Jobs run under a real tenant context so the tenant-scope plugin applies to
 * them exactly as it does to an HTTP request. A background job that could read
 * across tenants would defeat the whole isolation model.
 */
export async function runAsSystem<T>(
  opts: { tenantId?: string; requestId: string; actorType?: ActorType },
  fn: () => T | Promise<T>,
): Promise<T> {
  return runWithContext(
    {
      requestId: opts.requestId,
      tenantId: opts.tenantId,
      permissions: new Set<string>(),
      actorType: opts.actorType ?? 'system',
    },
    async () => fn(),
  );
}
