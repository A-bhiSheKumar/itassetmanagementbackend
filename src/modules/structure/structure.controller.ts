import type { Request, Response } from 'express';
import { ok, created, noContent } from '../../core/http/index.js';
import { createOrgUnit, updateOrgUnit, type OrgUnitDocument, type OrgUnitKind } from '../people/index.js';
import * as service from './structure.service.js';

function presentOrgUnit(unit: OrgUnitDocument) {
  return {
    id: String(unit._id),
    name: unit.name,
    code: unit.code,
    description: unit.description,
    parentId: unit.parentId,
    path: unit.path,
    managerId: unit.managerId,
    status: unit.status,
    // Locations carry these; departments and cost centres do not.
    ...(unit.address ? { address: unit.address } : {}),
    ...(unit.timezone !== undefined ? { timezone: unit.timezone } : {}),
  };
}

export function orgUnitController(kind: OrgUnitKind) {
  return {
    async index(_req: Request, res: Response): Promise<void> {
      const rows = await service.listUnitsWithCounts(kind);
      ok(
        res,
        rows.map(({ unit, peopleCount, assetCount }) => ({ ...presentOrgUnit(unit), peopleCount, assetCount })),
      );
    },

    async create(req: Request, res: Response): Promise<void> {
      const unit = await createOrgUnit(kind, req.body as Record<string, unknown>);
      created(res, presentOrgUnit(unit));
    },

    async update(req: Request, res: Response): Promise<void> {
      const unit = await updateOrgUnit(kind, req.params.id!, req.body as Record<string, unknown>);
      ok(res, presentOrgUnit(unit));
    },

    async destroy(req: Request, res: Response): Promise<void> {
      await service.deleteUnit(kind, req.params.id!);
      noContent(res);
    },

    async moveContents(req: Request, res: Response): Promise<void> {
      const { toId } = req.body as { toId: string };
      ok(res, await service.moveContents(kind, req.params.id!, toId));
    },
  };
}
