import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, maskSecret } from '../../src/core/crypto/index.js';

describe('stored secrets', () => {
  it('round-trip, with a fresh IV each time', () => {
    const a = encryptSecret('ABCDE-12345');
    const b = encryptSecret('ABCDE-12345');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('ABCDE-12345');
  });

  it('refuse a tampered value rather than decrypting it to garbage', () => {
    const parts = encryptSecret('ABCDE-12345').split('.');
    const data = Buffer.from(parts[3]!, 'base64url');
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });

  it('mask to the last four characters, ignoring dashes', () => {
    expect(maskSecret('ABCDE-FGHIJ-3F7Q')).toBe('••••••••3F7Q');
  });
});
