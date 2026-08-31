export {
  connectDatabase,
  disconnectDatabase,
  registerGlobalPlugins,
  assertPluginsRegistered,
  defineModel,
  type TenantScopedFields,
  type Scoped,
  assertTransactionsSupported,
  isDatabaseHealthy,
  mongoose,
} from './connection.js';
export {
  withTransaction,
  upsertWithRetry,
  TransactionTimeoutError,
} from './transaction.js';
export {
  tenantScopePlugin,
  markSchemaGlobal,
  type TenantScopeOptions,
} from './plugins/tenantScope.plugin.js';
export { softDeletePlugin } from './plugins/softDelete.plugin.js';
export { auditFieldsPlugin } from './plugins/auditFields.plugin.js';
