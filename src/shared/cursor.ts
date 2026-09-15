/**
 * Keyset pagination cursors: newest first, `_id` breaking ties.
 *
 * Opaque to clients. A malformed cursor decodes to null and the caller serves
 * page one — a client bug is recoverable, a 500 is not.
 */

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt.toISOString(), i: id })).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { c: string; i: string };
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime()) || typeof parsed.i !== 'string') return null;
    return { createdAt, id: parsed.i };
  } catch {
    return null;
  }
}

/** The filter fragment that continues after `cursor`, for a `{ createdAt: -1, _id: -1 }` sort. */
export function afterCursor(cursor: string | undefined): Record<string, unknown> {
  const decoded = cursor ? decodeCursor(cursor) : null;
  if (!decoded) return {};
  return {
    $or: [{ createdAt: { $lt: decoded.createdAt } }, { createdAt: decoded.createdAt, _id: { $lt: decoded.id } }],
  };
}

/** Splits the one extra row fetched into `hasMore`, and cursors the page's last row. */
export function toPage<T extends { _id: unknown; createdAt?: Date | null }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    hasMore,
    cursor: hasMore && last?.createdAt ? encodeCursor(last.createdAt, String(last._id)) : null,
  };
}

/**
 * Tokens for a `^prefix` search: each whole value and each word in it, lower
 * case, so "dell" finds "Dell Technologies" and "tech" finds it too.
 */
export function searchTokens(parts: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      parts
        .map((p) => (p ?? '').toLowerCase().trim())
        .filter(Boolean)
        .flatMap((p) => [p, ...p.split(/[\s\-_/.,@]+/)])
        .filter((t) => t.length > 1),
    ),
  ];
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
