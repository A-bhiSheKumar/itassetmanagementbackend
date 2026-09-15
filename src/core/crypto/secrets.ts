import crypto from 'node:crypto';
import { env } from '../../config/index.js';

/**
 * Encryption for secrets kept as data — licence keys, today.
 *
 * AES-256-GCM: authenticated, so a tampered value fails to decrypt rather than
 * decrypting to garbage. Each value carries its own random IV and a version
 * prefix, which is what lets the key be rotated later — decrypt by version,
 * re-encrypt under the new one — without a flag day.
 *
 * Stored as `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 */

const VERSION = 'v1';

function key(): Buffer {
  if (env.DATA_ENCRYPTION_KEY) return Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
  // Development and tests only — production refuses to start without a key.
  return crypto.createHash('sha256').update(`field-encryption:${env.JWT_ACCESS_SECRET}`).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, data] = stored.split('.');
  if (version !== VERSION || !iv || !tag || data === undefined) {
    throw new Error('Unrecognised encrypted value.');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

/** "••••••••3F7Q" — enough to tell two keys apart in a list, not enough to use one. */
export function maskSecret(plaintext: string): string {
  const tail = plaintext.replace(/[\s-]/g, '').slice(-4);
  return `••••••••${tail}`;
}
