import type { Response } from 'express';
import { getContext } from '../context/index.js';

/**
 * The response envelope (docs/04-api-design.md §1).
 *
 * Every response has the same shape. `requestId` appears in the body, in every
 * log line and in Sentry — a customer pastes it into support and we find the
 * exact request.
 */

export interface PaginationMeta {
  cursor?: string | null;
  hasMore: boolean;
  limit: number;
}

export interface ResponseMeta {
  requestId: string;
  pagination?: PaginationMeta;
  total?: number;
  totalIsEstimate?: boolean;
  [key: string]: unknown;
}

function baseMeta(extra?: Omit<ResponseMeta, 'requestId'>): ResponseMeta {
  return { requestId: getContext()?.requestId ?? 'unknown', ...extra };
}

export function ok<T>(res: Response, data: T, meta?: Omit<ResponseMeta, 'requestId'>): Response {
  return res.status(200).json({ success: true, data, meta: baseMeta(meta) });
}

export function created<T>(res: Response, data: T, location?: string): Response {
  if (location) res.setHeader('Location', location);
  return res.status(201).json({ success: true, data, meta: baseMeta() });
}

/** 202 — an async job was queued (imports, exports, reports, bulk operations). */
export function accepted(
  res: Response,
  job: { jobId: string; status: string; statusUrl: string },
): Response {
  return res.status(202).json({ success: true, data: job, meta: baseMeta() });
}

export function noContent(res: Response): Response {
  return res.status(204).send();
}

export function list<T>(
  res: Response,
  items: T[],
  meta: { pagination: PaginationMeta; total?: number; totalIsEstimate?: boolean },
): Response {
  return res.status(200).json({ success: true, data: items, meta: baseMeta(meta) });
}
