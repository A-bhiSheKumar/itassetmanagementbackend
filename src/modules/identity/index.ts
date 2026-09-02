export { UserModel, type User, type UserDocument } from './user.model.js';
export { RefreshTokenModel, type RefreshToken } from './refreshToken.model.js';
export {
  createUser,
  findUserByEmail,
  findUserById,
  authenticate,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllSessions,
  changePassword,
} from './identity.service.js';
export { authRoutes, meRoutes } from './auth.routes.js';
