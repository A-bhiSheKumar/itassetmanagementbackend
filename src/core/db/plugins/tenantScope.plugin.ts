import type { Schema, Query, Aggregate, Document } from 'mongoose';
import { getContext } from '../../context/index.js';
import { MissingTenantScopeError, CrossTenantWriteError } from '../../errors/index.js';

/**
 * Tenant isolation, layer 2 (ADR-002).
 *
 * Applied globally to every schema. Injects `tenantId` into every read, write
 * and aggregation from the ambient request context.
 *
 * The design decision that matters: when the context has NO tenant, this
 * THROWS. It does not fall back to an unfiltered query. An unfiltered query
 * returns every tenant's data and looks like it worked — which is exactly how
 * cross-tenant leaks reach production unnoticed. A thrown error fails the test
 * suite, fails in development, and fails loudly in production.
 *
 * Exemptions:
 *   - Models registered with { global: true }: Plan, Tenant, User. Short list,
 *     reviewed, asserted in tests/core/tenantScope.test.ts.
 *   - Code inside withoutTenantScope(reason, fn), which eslint restricts to
 *     src/modules/platform/ and which writes a platform audit record.
 */

/** find, findOne, findOneAnd*, count*, distinct — all pure reads. */
const READ_HOOKS = /^(find|count|estimatedDocumentCount|distinct)/;

/** updateOne, updateMany, replaceOne. */
const WRITE_HOOKS = /^(update|replace)/;

export interface TenantScopeOptions {
  global?: boolean;
}

/**
 * Opts a schema out of tenant scoping. Call BEFORE the model is compiled.
 *
 * Needed because the plugin is registered globally via mongoose.plugin(), which
 * applies it to every schema at model-compile time with no per-schema options.
 * A schema-level .plugin(tenantScopePlugin, { global: true }) does not help —
 * the global registration has already added the tenantId field by then.
 *
 * The list of global schemas is short and deliberate: Plan, Tenant, User,
 * RefreshToken, platform AuditLog. Everything else is tenant-scoped.
 */
export function markSchemaGlobal<S extends Schema>(schema: S): S {
  // Mongoose stores arbitrary schema options but only types the known keys.
  (schema as unknown as { set(k: string, v: unknown): void }).set('tenantScope', 'global');
  return schema;
}

function isGlobalSchema(schema: Schema, options: TenantScopeOptions): boolean {
  const opts = schema.options as Record<string, unknown>;
  return options.global === true || opts.tenantScope === 'global';
}

/**
 * Stamps tenantId from context and refuses a cross-tenant write.
 *
 * Registered on `validate`, NOT only on `save`: Mongoose runs validation as its
 * own internal pre-save hook, registered before any plugin's, so a pre('save')
 * stamp lands after `tenantId: required` has already failed. This cost an hour
 * once; the pre('save') hook below stays as a second line of defence for
 * save({ validateBeforeSave: false }).
 */
function stampTenant(doc: Document & { tenantId?: string }, hookName: string): void {
  const ctx = getContext();
  if (ctx?.tenantScopeBypass) return;

  if (!ctx?.tenantId) {
    throw new MissingTenantScopeError(doc.constructor.name, hookName);
  }

  if (doc.tenantId === undefined) {
    doc.tenantId = ctx.tenantId;
    return;
  }

  // A document arriving with another tenant's id is either a serious bug or an
  // attack. Either way it must not be written.
  if (doc.tenantId !== ctx.tenantId) {
    throw new CrossTenantWriteError(doc.constructor.name, doc.tenantId, ctx.tenantId);
  }
}

function applyTenantFilter(this: Query<unknown, unknown>): void {
  const ctx = getContext();

  if (ctx?.tenantScopeBypass) return;

  if (!ctx?.tenantId) {
    const op = (this as unknown as { op?: string }).op ?? 'query';
    throw new MissingTenantScopeError(this.model?.modelName ?? 'unknown', op);
  }

  // Setting tenantId here OVERRIDES any client-supplied value. Request bodies
  // and query strings never get to choose a tenant (ADR-002, layer 4).
  this.setQuery({ ...this.getFilter(), tenantId: ctx.tenantId });
}

export function tenantScopePlugin(schema: Schema, options: TenantScopeOptions = {}): void {
  if (isGlobalSchema(schema, options)) return;

  schema.add({
    tenantId: {
      type: String,
      required: true,
      index: true,
      immutable: true,
    },
  });

  schema.pre(READ_HOOKS, applyTenantFilter);
  schema.pre(WRITE_HOOKS, applyTenantFilter);

  // deleteOne/deleteMany exist as BOTH document and query middleware in
  // Mongoose 7+. Registering them by name with { query: true, document: false }
  // is the only way to be sure the filter lands on the query form — a regex
  // would attach to both and the document form has no filter to modify.
  schema.pre('deleteOne', { query: true, document: false }, applyTenantFilter);
  schema.pre('deleteMany', { query: true, document: false }, applyTenantFilter);

  // ── Aggregations ───────────────────────────────────────────────────────────
  // The $match must be UNSHIFTED to the front. Appending it after a $group or
  // $lookup would filter results that had already been computed across every
  // tenant — correct-looking output, catastrophic reads.
  schema.pre('aggregate', function (this: Aggregate<unknown[]>) {
    const ctx = getContext();
    if (ctx?.tenantScopeBypass) return;

    if (!ctx?.tenantId) {
      throw new MissingTenantScopeError('aggregate', 'aggregate');
    }

    this.pipeline().unshift({ $match: { tenantId: ctx.tenantId } });
  });

  // ── Inserts ────────────────────────────────────────────────────────────────
  schema.pre('validate', function (this: Document & { tenantId?: string }) {
    stampTenant(this, 'validate');
  });

  schema.pre('save', function (this: Document & { tenantId?: string }) {
    stampTenant(this, 'save');
  });

  // insertMany bypasses document middleware entirely, so it needs its own hook.
  // Mongoose inspects fn.length: declaring `next` means the hook MUST call it,
  // or every insertMany hangs until the test timeout.
  schema.pre('insertMany', function (next, docs: Array<{ tenantId?: string }>) {
    const ctx = getContext();

    if (!ctx?.tenantScopeBypass) {
      if (!ctx?.tenantId) {
        next(new MissingTenantScopeError('insertMany', 'insertMany'));
        return;
      }

      for (const doc of docs) {
        if (doc.tenantId === undefined) {
          doc.tenantId = ctx.tenantId;
        } else if (doc.tenantId !== ctx.tenantId) {
          next(new CrossTenantWriteError('insertMany', doc.tenantId, ctx.tenantId));
          return;
        }
      }
    }

    next();
  });
}
