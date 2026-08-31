import type { Request, Response } from 'express';
import { ok, created, list, noContent } from '../../core/http/index.js';
import { flattenCustomFields } from '../catalog/index.js';
import type { PersonDocument } from './person.model.js';
import type { OrgUnitKind, OrgUnitDocument } from './orgUnit.model.js';
import * as service from './people.service.js';

function presentPerson(person: PersonDocument) {
  return {
    id: String(person._id),
    firstName: person.firstName,
    lastName: person.lastName,
    fullName: `${person.firstName} ${person.lastName}`,
    email: person.email,
    employeeCode: person.employeeCode,
    phone: person.phone,
    jobTitle: person.jobTitle,
    departmentId: person.departmentId,
    locationId: person.locationId,
    costCentreId: person.costCentreId,
    managerId: person.managerId,
    membershipId: person.membershipId,
    type: person.type,
    status: person.status,
    startDate: person.startDate,
    endDate: person.endDate,
    // Buckets are storage, not contract: clients get `{ ram_gb: 36 }`.
    customFields: flattenCustomFields(person.cf as never),
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
  };
}

export async function index(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as {
    limit: number;
    cursor?: string;
    status?: string;
    departmentId?: string;
    locationId?: string;
    q?: string;
  };

  const result = await service.listPeople(query);

  list(res, result.items.map(presentPerson), {
    pagination: { cursor: result.cursor, hasMore: result.hasMore, limit: query.limit },
  });
}

export async function show(req: Request, res: Response): Promise<void> {
  ok(res, presentPerson(await service.findPerson(req.params.id!)));
}

export async function create(req: Request, res: Response): Promise<void> {
  const person = await service.createPerson(req.body as service.PersonInput);
  created(res, presentPerson(person), `/api/v1/people/${String(person._id)}`);
}

export async function update(req: Request, res: Response): Promise<void> {
  ok(res, presentPerson(await service.updatePerson(req.params.id!, req.body as service.PersonInput)));
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  ok(res, presentPerson(await service.deactivatePerson(req.params.id!)));
}

export async function destroy(req: Request, res: Response): Promise<void> {
  await service.deletePerson(req.params.id!);
  noContent(res);
}

// ── Org units ──────────────────────────────────────────────────────────────

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
      const units = await service.listOrgUnits(kind);
      ok(res, units.map(presentOrgUnit));
    },

    async create(req: Request, res: Response): Promise<void> {
      const unit = await service.createOrgUnit(kind, req.body as Record<string, unknown>);
      created(res, presentOrgUnit(unit));
    },

    async update(req: Request, res: Response): Promise<void> {
      const unit = await service.updateOrgUnit(kind, req.params.id!, req.body as Record<string, unknown>);
      ok(res, presentOrgUnit(unit));
    },

    async destroy(req: Request, res: Response): Promise<void> {
      await service.deleteOrgUnit(kind, req.params.id!);
      noContent(res);
    },
  };
}
