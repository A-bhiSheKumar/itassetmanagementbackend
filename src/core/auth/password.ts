import argon2 from 'argon2';
import crypto from 'node:crypto';
import { isTest } from '../../config/index.js';

/**
 * Password hashing.
 *
 * Argon2id — memory-hard, so a GPU array buys an attacker far less than it does
 * against bcrypt. Parameters follow OWASP's 2024 guidance (19 MiB, t=2, p=1).
 *
 * Deliberately weakened under NODE_ENV=test only. The security suites hash
 * dozens of passwords per run and production parameters make them slow enough
 * that people stop running them — which costs more security than the parameters
 * buy. Guarded by isTest, which is derived from the validated env schema, so it
 * cannot be switched on in a deployed environment.
 */
const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: isTest ? 8_192 : 19_456,
  // 2 is argon2's own minimum — it rejects 1 outright. Only memoryCost is
  // relaxed for tests.
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // A malformed stored hash must read as "wrong password", never as an error
    // the caller might handle differently — the difference is observable.
    return false;
  }
}

/**
 * Burns roughly the same time as a real verification.
 *
 * Without this, "unknown email" returns in 2ms and "wrong password" in 60ms,
 * which turns the login endpoint into a user-enumeration oracle regardless of
 * how carefully the response bodies are matched.
 */
let dummyHash: Promise<string> | undefined;

export async function burnPasswordTime(): Promise<void> {
  // Computed lazily and cached. A module-level promise would reject at import
  // time on any misconfiguration, with no handler attached — an unhandled
  // rejection that takes the process down rather than failing one request.
  dummyHash ??= argon2.hash('never-matches-anything', ARGON_OPTIONS);
  await argon2.verify(await dummyHash, 'wrong');
}

/** Opaque, high-entropy token for refresh tokens, invitations and resets. */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Tokens are stored hashed, so a database dump does not yield working
 * credentials. SHA-256 rather than argon2 is correct here: these are 256 bits
 * of random, not a guessable secret, so there is nothing to brute-force and the
 * lookup has to be fast.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
