import jwt, { type SignOptions } from 'jsonwebtoken';
import { ulid } from 'ulid';
import { env } from '../../config/index.js';
import { TokenExpiredError, UnauthenticatedError } from '../errors/index.js';

/**
 * Access tokens (docs/02-architecture.md §4).
 *
 * Two shapes:
 *   - a USER token, minted at login before a tenant is chosen. It can do
 *     exactly two things: list your organisations, and select one.
 *   - a TENANT token, minted by selecting a membership. Everything else.
 *
 * Claims are a CACHE, not authority. `pv` (permission version) and `tv` (token
 * version) are compared against the database on every request; a mismatch
 * rejects the token. That gives instant revocation without a blocklist, and
 * means a stale permission set cannot outlive one request.
 */

export interface UserTokenClaims {
  scope: 'user';
  sub: string;
  tv: number;
  jti: string;
}

export interface TenantTokenClaims {
  scope: 'tenant';
  sub: string;
  tid: string;
  mid: string;
  pv: number;
  tv: number;
  jti: string;
}

export type AccessTokenClaims = UserTokenClaims | TenantTokenClaims;

const ISSUER = 'itam';

// jsonwebtoken types expiresIn as a narrow template literal union. The value is
// validated as a duration string by the env schema, so the cast is safe and the
// alternative — hardcoding the union here — would drift from config.
const ACCESS_TTL = env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'];

export function signUserToken(input: { userId: string; tokenVersion: number }): string {
  return jwt.sign(
    { scope: 'user', tv: input.tokenVersion, jti: ulid() } satisfies Omit<UserTokenClaims, 'sub'>,
    env.JWT_ACCESS_SECRET,
    { subject: input.userId, expiresIn: ACCESS_TTL, issuer: ISSUER },
  );
}

export function signTenantToken(input: {
  userId: string;
  tenantId: string;
  membershipId: string;
  permVersion: number;
  tokenVersion: number;
}): string {
  return jwt.sign(
    {
      scope: 'tenant',
      tid: input.tenantId,
      mid: input.membershipId,
      pv: input.permVersion,
      tv: input.tokenVersion,
      jti: ulid(),
    },
    env.JWT_ACCESS_SECRET,
    { subject: input.userId, expiresIn: ACCESS_TTL, issuer: ISSUER },
  );
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      // Pin the algorithm. Without this a token signed `alg: none` — or with the
      // public key of an asymmetric pair — can be accepted.
      algorithms: ['HS256'],
    });

    if (typeof decoded === 'string' || !decoded.sub) throw new UnauthenticatedError();
    return decoded as unknown as AccessTokenClaims;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new TokenExpiredError();
    if (err instanceof UnauthenticatedError) throw err;
    throw new UnauthenticatedError('That session is not valid.');
  }
}

export function isTenantToken(claims: AccessTokenClaims): claims is TenantTokenClaims {
  return claims.scope === 'tenant';
}

/** Refresh tokens are opaque and hashed at rest — see auth/password.ts. */
export function refreshTokenExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export const REFRESH_COOKIE = 'itam_rt';

/**
 * httpOnly so XSS cannot read it; SameSite=Lax so a cross-site POST cannot use
 * it; path-scoped so it is only ever sent to the endpoints that need it.
 *
 * Split from the maxAge below because clearCookie() must be given the SAME
 * name, path and domain to match the cookie it is clearing — but passing maxAge
 * to it is deprecated in Express 5 and ignored.
 */
export function refreshCookieAttributes(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/api/v1/auth',
  };
}

export function refreshCookieOptions(secure: boolean) {
  return {
    ...refreshCookieAttributes(secure),
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}
