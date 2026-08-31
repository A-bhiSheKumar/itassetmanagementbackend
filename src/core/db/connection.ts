import mongoose, { model, type Schema } from 'mongoose';
import { env, isTest } from '../../config/index.js';
import { logger } from '../logging/index.js';
import { tenantScopePlugin } from './plugins/tenantScope.plugin.js';
import { softDeletePlugin } from './plugins/softDelete.plugin.js';
import { auditFieldsPlugin } from './plugins/auditFields.plugin.js';

/**
 * Database connection and global plugin registration.
 *
 * Plugins are registered on mongoose GLOBALLY, before any model is compiled.
 * That ordering is load-bearing: a model compiled before registerGlobalPlugins()
 * runs would silently skip tenant scoping. registerModelsAfterPluginsGuard()
 * below turns that ordering mistake into a startup error.
 */

let pluginsRegistered = false;

export function registerGlobalPlugins(): void {
  if (pluginsRegistered) return;

  /**
   * `applyPluginsToChildSchemas: false` is load-bearing.
   *
   * Mongoose applies global plugins to EMBEDDED schemas too by default. That
   * gave every nested object — a select field's options, a lifecycle state, an
   * address — its own `tenantId` (required and immutable), `deletedAt` and
   * `createdBy`. The pollution is invisible on insert and then makes any later
   * assignment to the parent path fail with "Path `tenantId` is immutable".
   *
   * It is also conceptually wrong: a subdocument belongs to its parent and
   * inherits the parent's tenant. It has no independent existence to scope.
   *
   * Order matters too: tenant scope first, so its $match reaches the front of
   * aggregation pipelines ahead of the soft-delete match.
   */
  // Must be a global setting, set BEFORE the plugins are registered — passing
  // it as a plugin option is silently ignored.
  mongoose.set('applyPluginsToChildSchemas', false);

  mongoose.plugin(tenantScopePlugin);
  mongoose.plugin(softDeletePlugin);
  mongoose.plugin(auditFieldsPlugin);

  mongoose.set('strictQuery', true);
  // Reject unknown keys in updates rather than silently dropping them.
  mongoose.set('strict', 'throw');

  pluginsRegistered = true;
  logger.debug('Global mongoose plugins registered');
}

export function assertPluginsRegistered(): void {
  if (!pluginsRegistered) {
    throw new Error(
      'Models were compiled before registerGlobalPlugins() ran. Tenant scoping ' +
        'would be silently absent. Call registerGlobalPlugins() first.',
    );
  }
}

/**
 * ── Register at import time, not at connect time ──────────────────────────
 *
 * Mongoose applies global plugins when a model is COMPILED. Model files compile
 * at import, and `import { createApp } from './app.js'` at the top of main.ts
 * runs long before `start()` calls connectDatabase(). Registering plugins
 * inside connectDatabase() therefore left every model without tenant scoping —
 * silently, because an unscoped query looks like it works.
 *
 * This bug shipped once and was caught only because a unique index collided.
 * The side-effect registration below, the defineModel() guard, and the
 * "every model is tenant-scoped" test together make it unrepeatable.
 */
registerGlobalPlugins();

/**
 * Compiles a model, refusing to do so before the global plugins are registered.
 *
 * Every model in the system goes through this rather than mongoose.model()
 * directly. Importing it also guarantees this module — and therefore the
 * registration above — has been evaluated first.
 */
/**
 * Fields the global plugins add at runtime.
 *
 * Mongoose's InferSchemaType only sees what the schema literal declares, so
 * these are invisible to the type system despite existing on every
 * tenant-scoped document. Intersect with `Scoped<T>` where a caller reads them.
 */
export interface TenantScopedFields {
  tenantId: string;
  deletedAt: Date | null;
  deletedBy: string | null;
  createdBy: string | null;
  updatedBy: string | null;
}

export type Scoped<T> = T & TenantScopedFields;

export function defineModel<TSchema extends Schema>(name: string, schema: TSchema) {
  assertPluginsRegistered();
  // Generic over the SCHEMA, not over an unrelated document type. Writing this
  // as `defineModel<T>(...): Model<T>` made every call site infer Model<unknown>
  // (silently losing every document type) and sent tsc into an inference
  // explosion that exhausted an 8 GB heap. Inferring from the schema gives real
  // types and compiles instantly.
  return model(name, schema);
}

export interface ConnectOptions {
  uri?: string;
}

export async function connectDatabase(options: ConnectOptions = {}): Promise<typeof mongoose> {
  registerGlobalPlugins();

  const uri = options.uri ?? env.MONGO_URI;

  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));

  /**
   * Surface index build failures.
   *
   * autoIndex creates indexes in the background and, by default, a failure is
   * only ever emitted on this event — nothing throws, nothing logs, and the
   * index simply does not exist. A malformed partial filter cost us a silently
   * missing warranty index for three milestones.
   */
  for (const model of Object.values(mongoose.models)) {
    model.on('index', (err: Error | undefined) => {
      if (err) {
        logger.error(
          { err, model: model.modelName },
          'INDEX BUILD FAILED — queries on this collection will scan',
        );
      }
    });
  }
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));

  await mongoose.connect(uri, {
    // Sized for a single API replica. Tune against real pool-utilisation
    // metrics before scaling out — an oversized pool exhausts Atlas connections
    // faster than an undersized one causes queueing.
    maxPoolSize: isTest ? 5 : 20,
    minPoolSize: isTest ? 1 : 2,
    serverSelectionTimeoutMS: 8_000,
    socketTimeoutMS: 45_000,
    retryWrites: true,
  });

  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close();
  logger.info('MongoDB disconnected');
}

export function isDatabaseHealthy(): boolean {
  return mongoose.connection.readyState === 1;
}

/**
 * Multi-document transactions require a replica set. A standalone mongod accepts
 * the connection and then fails the first transaction at runtime — so we check
 * at boot instead of discovering it during the first asset assignment.
 */
export async function assertTransactionsSupported(): Promise<void> {
  const admin = mongoose.connection.db?.admin();
  if (!admin) throw new Error('No database handle — connect first.');

  const info = (await admin.command({ hello: 1 })) as { setName?: string; msg?: string };
  const isReplicaSet = Boolean(info.setName);
  const isSharded = info.msg === 'isdbgrid';

  if (!isReplicaSet && !isSharded) {
    throw new Error(
      'MongoDB is running as a standalone. Multi-document transactions are ' +
        'required (assignment exclusivity, import commits). Start a replica set: ' +
        'see docker-compose.yml.',
    );
  }
}

export { mongoose };
