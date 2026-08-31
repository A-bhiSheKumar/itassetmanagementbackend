/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Express, Router } from 'express';
import { getGuardMetadata, type GuardMetadata } from '../../src/core/authz/index.js';

/**
 * Walks the Express router stack and enumerates every registered route.
 *
 * This is what makes the security suites GENERATED rather than hand-written.
 * A hand-maintained isolation suite is one forgotten pull request away from
 * being a false sense of security; a generated one fails the build the moment
 * an unguarded endpoint is added.
 */

export interface RouteEntry {
  method: string;
  path: string;
  guard?: GuardMetadata;
}

/**
 * Express stores a mount path as a compiled regexp, not a string. Decoding it
 * is unpleasant but beats maintaining a parallel manifest that can drift from
 * the actual router — the drift is precisely the failure mode this guards.
 */
function decodeMountPath(layer: any): string {
  if (typeof layer.path === 'string') return layer.path;

  const source: string | undefined = layer.regexp?.source;
  if (!source) return '';

  // The router's own root layer.
  if (source === '^\\/?(?=\\/|$)' || source === '^\\/?$') return '';

  const match = source.match(/^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/);
  if (!match?.[1]) return '';

  return `/${match[1].replace(/\\\//g, '/').replace(/\\\./g, '.')}`;
}

function walk(stack: any[], prefix: string, out: RouteEntry[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const path = `${prefix}${layer.route.path}`.replace(/\/{2,}/g, '/') || '/';

      // The guard is whichever handler on this route was tagged by
      // requirePermission/requireAuth/markPublic.
      const guard = layer.route.stack
        .map((s: any) => getGuardMetadata(s.handle))
        .find(Boolean) as GuardMetadata | undefined;

      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        out.push({ method: method.toUpperCase(), path, guard });
      }
      continue;
    }

    if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, `${prefix}${decodeMountPath(layer)}`, out);
    }
  }
}

export function collectRoutes(app: Express | Router, basePrefix = ''): RouteEntry[] {
  const stack = (app as any)._router?.stack ?? (app as any).stack ?? [];
  const routes: RouteEntry[] = [];
  walk(stack, basePrefix, routes);
  return routes;
}

/** Routes that read or write tenant data, and so must be isolation-tested. */
export function tenantScopedRoutes(routes: RouteEntry[]): RouteEntry[] {
  return routes.filter((r) => r.guard?.permission !== undefined);
}

/** Substitutes a concrete id for each :param so a route can actually be called. */
export function fillParams(path: string, value: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, value);
}

/**
 * Does this route address a specific RECORD?
 *
 * Only `:id` and `:somethingId` are object references. Others — `:from` on
 * `/lifecycle/transitions/:from`, or a future `:slug` — are value parameters,
 * and substituting another tenant's record id into one proves nothing.
 *
 * Those routes are not skipped: they get the leakage check instead, which is
 * the property that actually matters for them.
 */
export function hasRecordIdParam(path: string): boolean {
  return /:(id|[A-Za-z0-9_]*Id)(\/|$)/.test(path);
}
