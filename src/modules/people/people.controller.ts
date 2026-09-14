import type { Request, Response } from 'express';
import { ok, created, list, noContent } from '../../core/http/index.js';
import { flattenCustomFields } from '../catalog/index.js';
import type { PersonDocument } from './person.model.js';
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
