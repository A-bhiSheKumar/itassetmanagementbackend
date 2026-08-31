import { ulid } from 'ulid';
import {
  hashPassword,
  verifyPassword,
  burnPasswordTime,
  generateToken,
  hashToken,
  refreshTokenExpiry,
} from '../../core/auth/index.js';
import { UnauthenticatedError, DuplicateValueError, AppError, ErrorCode } from '../../core/errors/index.js';
import { logger } from '../../core/logging/index.js';
import { UserModel, type UserDocument } from './user.model.js';
import { RefreshTokenModel } from './refreshToken.model.js';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export async function createUser(input: {
  email: string;
  password: string;
  name: string;
}): Promise<UserDocument> {
  try {
    return await UserModel.create({
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw new DuplicateValueError('email', input.email);
    }
    throw err;
  }
}

export function findUserByEmail(email: string): Promise<UserDocument | null> {
  return UserModel.findOne({ email })
    .collation({ locale: 'en', strength: 2 })
    .select('+passwordHash')
    .exec();
}

export function findUserById(id: string): Promise<UserDocument | null> {
  return UserModel.findById(id).exec();
}

/**
 * Verifies credentials.
 *
 * Every failure path — unknown email, wrong password, locked account — returns
 * the SAME error and burns roughly the same amount of time. Otherwise the
 * endpoint tells an attacker which emails have accounts, which is the first
 * step of every credential-stuffing campaign.
 */
export async function authenticate(email: string, password: string): Promise<UserDocument> {
  const generic = new UnauthenticatedError('That email or password is not correct.');

  const user = await findUserByEmail(email);

  if (!user) {
    await burnPasswordTime();
    throw generic;
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await burnPasswordTime();
    throw generic;
  }

  if (user.status !== 'active') {
    await burnPasswordTime();
    throw generic;
  }

  const valid = await verifyPassword(user.passwordHash, password);

  if (!valid) {
    user.failedLoginCount += 1;
    if (user.failedLoginCount >= MAX_FAILED_LOGINS) {
      user.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
      user.failedLoginCount = 0;
      logger.warn({ userId: String(user._id) }, 'Account locked after repeated failed logins');
    }
    await user.save();
    throw generic;
  }

  user.failedLoginCount = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date();
  await user.save();

  return user;
}

export interface IssuedRefreshToken {
  token: string;
  familyId: string;
}

export async function issueRefreshToken(input: {
  userId: string;
  familyId?: string;
  ip?: string;
  userAgent?: string;
}): Promise<IssuedRefreshToken> {
  const token = generateToken();
  const familyId = input.familyId ?? ulid();

  await RefreshTokenModel.create({
    userId: input.userId,
    familyId,
    tokenHash: hashToken(token),
    expiresAt: refreshTokenExpiry(),
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  return { token, familyId };
}

/**
 * Rotates a refresh token, with reuse detection.
 *
 * A token that has ALREADY been rotated should never be presented again. If it
 * is, either it was stolen or the legitimate client replayed it — and we cannot
 * tell which. So the whole family is revoked: the attacker loses access, and
 * the real user is forced to sign in again. Annoying once; far better than an
 * attacker holding a valid session for thirty days undetected.
 */
export async function rotateRefreshToken(
  presented: string,
  meta: { ip?: string; userAgent?: string },
): Promise<{ userId: string; token: string; familyId: string }> {
  const tokenHash = hashToken(presented);
  const existing = await RefreshTokenModel.findOne({ tokenHash }).exec();

  if (!existing) throw new UnauthenticatedError('That session is not valid.');

  if (existing.revokedAt || existing.rotatedAt) {
    await RefreshTokenModel.updateMany(
      { familyId: existing.familyId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'reuse_detected' } },
    );

    logger.error(
      { userId: existing.userId, familyId: existing.familyId },
      'Refresh token reuse detected — family revoked',
    );

    throw new UnauthenticatedError('That session is no longer valid. Please sign in again.');
  }

  if (existing.expiresAt < new Date()) {
    throw new UnauthenticatedError('That session has expired.');
  }

  existing.rotatedAt = new Date();
  existing.revokedReason = 'rotation';
  await existing.save();

  const issued = await issueRefreshToken({
    userId: existing.userId,
    familyId: existing.familyId,
    ...meta,
  });

  return { userId: existing.userId, token: issued.token, familyId: issued.familyId };
}

export async function revokeRefreshToken(presented: string): Promise<void> {
  await RefreshTokenModel.updateOne(
    { tokenHash: hashToken(presented), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
  );
}

export async function revokeAllSessions(userId: string, reason: string): Promise<void> {
  await RefreshTokenModel.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

/**
 * Changing a password signs every device out. A password change is usually a
 * response to suspected compromise, and leaving other sessions alive defeats
 * the point of changing it.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await UserModel.findById(userId).select('+passwordHash').exec();
  if (!user) throw new UnauthenticatedError();

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'Your current password is not correct.', {
      fields: { currentPassword: ['Not correct.'] },
    });
  }

  user.passwordHash = await hashPassword(newPassword);
  user.tokenVersion += 1;
  await user.save();

  await revokeAllSessions(userId, 'password_change');
}
