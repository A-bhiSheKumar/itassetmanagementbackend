export { RoleModel, type Role, type RoleDocument } from './role.model.js';
export {
  seedSystemRoles,
  syncSystemRolePermissions,
  listRoles,
  findRolesByIds,
  findRoleByKey,
  resolvePermissions,
  assertCanGrantRoles,
} from './role.service.js';
export { roleRoutes } from './role.routes.js';
