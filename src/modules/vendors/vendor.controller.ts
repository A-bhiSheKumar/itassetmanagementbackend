import type { Request, Response } from 'express';
import { ok, created, list, noContent } from '../../core/http/index.js';
import type { VendorDocument } from './vendor.model.js';
import * as service from './vendor.service.js';

export function presentVendor(v: VendorDocument) {
  return {
    id: String(v._id),
    name: v.name,
    kinds: v.kinds,
    website: v.website,
    email: v.email,
    phone: v.phone,
    contactName: v.contactName,
    accountNumber: v.accountNumber,
    address: v.address,
    notes: v.notes,
    status: v.status,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

export async function index(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { limit: number; cursor?: string; q?: string; status?: string; kind?: string };
  const page = await service.listVendors(query);
  list(res, page.items.map(presentVendor), { pagination: { cursor: page.cursor, hasMore: page.hasMore, limit: query.limit } });
}

export async function show(req: Request, res: Response): Promise<void> {
  ok(res, presentVendor(await service.findVendor(req.params.id!)));
}

export async function create(req: Request, res: Response): Promise<void> {
  const vendor = await service.createVendor(req.body as service.VendorInput);
  created(res, presentVendor(vendor), `/api/v1/vendors/${String(vendor._id)}`);
}

export async function update(req: Request, res: Response): Promise<void> {
  ok(res, presentVendor(await service.updateVendor(req.params.id!, req.body as service.VendorInput)));
}

export async function destroy(req: Request, res: Response): Promise<void> {
  await service.deleteVendor(req.params.id!);
  noContent(res);
}
