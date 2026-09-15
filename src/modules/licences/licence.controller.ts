import type { Request, Response } from 'express';
import { ok, created, list, noContent } from '../../core/http/index.js';
import { NotFoundError } from '../../core/errors/index.js';
import { PersonModel } from '../people/index.js';
import { vendorNames } from '../vendors/index.js';
import type { LicenceDocument } from './licence.model.js';
import * as service from './licence.service.js';

function present(l: LicenceDocument, vendors: Map<string, string>) {
  return {
    id: String(l._id),
    name: l.name,
    vendorId: l.vendorId,
    vendorName: l.vendorId ? (vendors.get(l.vendorId) ?? null) : null,
    type: l.type,
    seats: l.seats,
    seatsUsed: l.seatsUsed,
    // Never the key: only whether there is one, and its last characters.
    hasKey: l.keyHint !== null,
    keyHint: l.keyHint,
    purchasedAt: l.purchasedAt,
    startsAt: l.startsAt,
    expiresAt: l.expiresAt,
    autoRenew: l.autoRenew,
    billingCycle: l.billingCycle,
    cost: l.cost,
    orderRef: l.orderRef,
    notes: l.notes,
    status: l.status,
    createdAt: l.createdAt,
  };
}

async function presentMany(rows: LicenceDocument[]) {
  const vendors = await vendorNames(rows.map((r) => r.vendorId));
  return rows.map((r) => present(r, vendors));
}

const one = async (l: LicenceDocument) => (await presentMany([l]))[0];

export async function index(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as Parameters<typeof service.listLicences>[0];
  const page = await service.listLicences(query);
  list(res, await presentMany(page.items), { pagination: { cursor: page.cursor, hasMore: page.hasMore, limit: query.limit } });
}

export async function show(req: Request, res: Response): Promise<void> {
  ok(res, await one(await service.findLicence(req.params.id!)));
}

export async function create(req: Request, res: Response): Promise<void> {
  const licence = await service.createLicence(req.body);
  created(res, await one(licence), `/api/v1/licences/${String(licence._id)}`);
}

export async function update(req: Request, res: Response): Promise<void> {
  ok(res, await one(await service.updateLicence(req.params.id!, req.body)));
}

export async function destroy(req: Request, res: Response): Promise<void> {
  await service.deleteLicence(req.params.id!);
  noContent(res);
}

export async function reveal(req: Request, res: Response): Promise<void> {
  // No caching anywhere between here and the screen.
  res.setHeader('Cache-Control', 'no-store');
  ok(res, await service.revealKey(req.params.id!));
}

export async function seats(req: Request, res: Response): Promise<void> {
  await service.findLicence(req.params.id!);
  ok(res, await service.seatsOn(req.params.id!, req.query.includeRevoked === 'true'));
}

export async function allocate(req: Request, res: Response): Promise<void> {
  const seat = await service.allocateSeat(req.params.id!, req.body);
  const [named] = (await service.seatsOn(req.params.id!)).filter((s) => s.id === String(seat._id));
  created(res, named);
}

export async function revoke(req: Request, res: Response): Promise<void> {
  await service.revokeSeat(req.params.id!, req.params.seatId!);
  noContent(res);
}

export async function forPerson(req: Request, res: Response): Promise<void> {
  // Resolved first: an empty list for someone in another organisation would
  // confirm the id exists somewhere (ADR-015). Missing and foreign look the same.
  if (!(await PersonModel.exists({ _id: req.params.id! }))) throw new NotFoundError('Person');
  ok(res, await service.seatsFor(req.params.id!));
}
