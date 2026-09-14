import type { Request, Response } from 'express';
import { ok, created, noContent } from '../../core/http/index.js';
import type { SavedViewModule } from './savedView.model.js';
import * as service from './savedView.service.js';

function present(view: { _id: unknown; module: string; name: string; query: string; updatedAt?: Date }) {
  return { id: String(view._id), module: view.module, name: view.name, query: view.query, updatedAt: view.updatedAt };
}

export async function index(req: Request, res: Response): Promise<void> {
  const { module } = req.query as unknown as { module: SavedViewModule };
  ok(res, (await service.listViews(module)).map(present));
}

export async function save(req: Request, res: Response): Promise<void> {
  const { module, name, query } = req.body as { module: SavedViewModule; name: string; query: string };
  const view = await service.saveView(module, name, query);
  created(res, present(view!));
}

export async function remove(req: Request, res: Response): Promise<void> {
  await service.deleteView(req.params.id!);
  noContent(res);
}
