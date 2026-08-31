/**
 * Content-type verification by MAGIC BYTES, not by what the client claimed.
 *
 * A client-declared MIME type is a hint from an untrusted party. Renaming
 * payload.exe to invoice.pdf changes the declared type and nothing else, so the
 * only honest check is to read the first bytes of what actually arrived.
 */

export interface FileSignature {
  mime: string;
  extensions: string[];
  /** Byte prefix, with `null` meaning "any byte here". */
  magic: Array<number | null>;
  offset?: number;
}

const SIGNATURES: FileSignature[] = [
  { mime: 'application/pdf', extensions: ['pdf'], magic: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'image/png', extensions: ['png'], magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', extensions: ['jpg', 'jpeg'], magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', extensions: ['gif'], magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', extensions: ['webp'], magic: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
  // Every modern Office format is a zip. The distinction is inside the archive,
  // so the extension decides which of them we call it — but it is at least
  // provably a zip and not an executable.
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['xlsx', 'docx', 'pptx'],
    magic: [0x50, 0x4b, 0x03, 0x04],
  },
  { mime: 'application/msword', extensions: ['doc', 'xls', 'ppt'], magic: [0xd0, 0xcf, 0x11, 0xe0] },
];

/**
 * Extensions we accept. Deliberately an allowlist.
 *
 * SVG is absent on purpose: it is XML, it can carry script, and served inline
 * it executes in our origin. Accepting it would need `Content-Disposition:
 * attachment` plus a sandboxing CSP, and the feature does not earn that.
 */
export const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp',
  'xlsx', 'docx', 'pptx', 'doc', 'xls', 'ppt',
  'csv', 'txt',
]);

/** Types with no reliable signature, permitted only by extension. */
const PLAIN_TEXT_EXTENSIONS = new Set(['csv', 'txt']);

export function extensionOf(fileName: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName);
  return match?.[1]?.toLowerCase() ?? '';
}

export interface VerificationResult {
  ok: boolean;
  detectedMime: string | null;
  reason?: string;
}

/**
 * Verifies that a file's real bytes match its extension.
 *
 * Only the first few dozen bytes are needed, so callers fetch a range rather
 * than downloading whole files back out of object storage.
 */
export function verifyMagicBytes(fileName: string, head: Buffer): VerificationResult {
  const extension = extensionOf(fileName);

  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return { ok: false, detectedMime: null, reason: `.${extension || 'unknown'} files are not accepted.` };
  }

  if (PLAIN_TEXT_EXTENSIONS.has(extension)) {
    // No signature exists for plain text. Reject anything containing a NUL
    // byte, which no text file has and most binaries do.
    const looksBinary = head.subarray(0, 512).includes(0x00);
    return looksBinary
      ? { ok: false, detectedMime: null, reason: 'That file is not plain text.' }
      : { ok: true, detectedMime: extension === 'csv' ? 'text/csv' : 'text/plain' };
  }

  for (const signature of SIGNATURES) {
    if (!signature.extensions.includes(extension)) continue;
    if (!matches(head, signature)) continue;
    return { ok: true, detectedMime: signature.mime };
  }

  return {
    ok: false,
    detectedMime: null,
    reason: `That file's contents do not match a .${extension} file.`,
  };
}

function matches(head: Buffer, signature: FileSignature): boolean {
  const offset = signature.offset ?? 0;
  if (head.length < offset + signature.magic.length) return false;

  return signature.magic.every((byte, i) => byte === null || head[offset + i] === byte);
}
