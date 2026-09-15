import { Router, type Request, type Response } from 'express';
import { asyncHandler, ok } from '../../core/http/index.js';
import { validate, strictObject, idSchema } from '../../core/validation/index.js';
import { requireAuth, requirePermission, type Permission } from '../../core/authz/index.js';
import { getContext } from '../../core/context/index.js';
import { PermissionDeniedError } from '../../core/errors/index.js';
import { BIN_PERMISSION, BIN_TYPES, listBin, restoreItem, type BinType } from './recycleBin.service.js';

export const recycleBinRoutes = Router();

/**
 * The list is open to any signed-in member, and filtered to the kinds of
 * record they could have deleted. Someone with no such permission gets an
 * empty bin, not an error — there is simply nothing of theirs in it.
 */
recycleBinRoutes.get(
  '/',
  requireAuth(),
  asyncHandler(async (_req: Request, res: Response) => {
    const ctx = getContext();
    if (!ctx?.tenantId) throw new PermissionDeniedError();
    ok(res, await listBin(ctx.permissions));
  }),
);

/**
 * One restore route per kind, so each carries its permission statically — the
 * route-guard suite reads the guard off the route rather than trusting a
 * handler to check.
 */
const PLURAL: Record<BinType, string> = {
  asset: 'assets',
  person: 'people',
  location: 'locations',
  department: 'departments',
  document: 'documents',
  vendor: 'vendors',
  licence: 'licences',
};

const restoreSchema = { params: strictObject({ id: idSchema }) };

for (const type of BIN_TYPES) {
  recycleBinRoutes.post(
    `/${PLURAL[type]}/:id/restore`,
    requirePermission(BIN_PERMISSION[type] as Permission),
    validate(restoreSchema),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await restoreItem(type, req.params.id!));
    }),
  );
}
