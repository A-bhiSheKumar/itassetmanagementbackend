import { recordingTransport } from '../../src/modules/email/index.js';

/**
 * The single-use token from the latest link of this kind emailed to `address`.
 *
 * Tests follow the link the way a person would. Tokens are never returned by
 * the API, so the email is the only place a test — or an attacker watching an
 * admin's network tab — can find one.
 */
export function emailedToken(address: string, path: '/accept-invitation' | '/reset-password' | '/confirm-receipt'): string {
  const messages = [...recordingTransport().to(address)].reverse();

  for (const message of messages) {
    const match = message.text.match(new RegExp(`${path.replace('/', '\\/')}\\?token=([A-Za-z0-9_%-]+)`));
    if (match) return decodeURIComponent(match[1]!);
  }

  throw new Error(`No ${path} link has been emailed to ${address}.`);
}
