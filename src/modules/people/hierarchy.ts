import type { Model } from 'mongoose';
import { AppError, ErrorCode, NotFoundError } from '../../core/errors/index.js';

/**
 * Materialised-path hierarchies for departments, locations and cost centres.
 *
 * Each node stores `path[]` — the ids of every ancestor, root first. That turns
 * "everything under London" into a single indexed `{ path: londonId }` lookup
 * instead of a recursive `$graphLookup` on every scoped list query. Scoped
 * permissions run that query on essentially every request, so the difference is
 * not academic.
 *
 * The trade is that moving a node requires rewriting its subtree's paths. Moves
 * are rare; scoped reads are constant.
 */

/** Builds the path for a node about to be created or moved. */
export async function resolvePath<T extends { path: string[] }>(
  model: Model<T>,
  parentId: string | null,
): Promise<string[]> {
  if (!parentId) return [];

  const parent = await model.findById(parentId).select('path').lean<{ path: string[] }>();
  if (!parent) throw new NotFoundError('Parent');

  return [...parent.path, parentId];
}

/**
 * Rejects a move that would make a node its own ancestor.
 *
 * Without this, a cycle makes every subtree query either infinite or silently
 * wrong, and the damage is only visible much later.
 */
export async function assertNoCycle<T extends { path: string[] }>(
  model: Model<T>,
  nodeId: string,
  newParentId: string | null,
): Promise<void> {
  if (!newParentId) return;

  if (newParentId === nodeId) {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'A record cannot be its own parent.', {
      fields: { parentId: ['Cannot be itself.'] },
    });
  }

  const newParent = await model.findById(newParentId).select('path').lean<{ path: string[] }>();
  if (!newParent) throw new NotFoundError('Parent');

  if (newParent.path.includes(nodeId)) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_FAILED,
      'That would move this record underneath one of its own descendants.',
      { fields: { parentId: ['Creates a loop.'] } },
    );
  }
}

/**
 * Rewrites descendant paths after a move.
 *
 * Runs inline for now. Once a tenant has thousands of locations this belongs on
 * the job queue — the seam is here, and the operation is idempotent so moving it
 * later is safe.
 */
export async function rewriteDescendantPaths<T extends { path: string[] }>(
  model: Model<T>,
  nodeId: string,
  oldPath: string[],
  newPath: string[],
): Promise<void> {
  const descendants = await model
    .find({ path: nodeId } as never)
    .select('path')
    .lean<Array<{ _id: unknown; path: string[] }>>();

  await Promise.all(
    descendants.map((descendant) => {
      const tail = descendant.path.slice(oldPath.length + 1);
      return model.updateOne(
        { _id: descendant._id } as never,
        { $set: { path: [...newPath, nodeId, ...tail] } } as never,
      );
    }),
  );
}

/** Ids of a node and everything beneath it — the filter a scoped role needs. */
export async function subtreeIds<T extends { path: string[] }>(
  model: Model<T>,
  nodeIds: string[],
): Promise<string[]> {
  if (nodeIds.length === 0) return [];

  const descendants = await model
    .find({ path: { $in: nodeIds } } as never)
    .select('_id')
    .lean<Array<{ _id: unknown }>>();

  return [...nodeIds, ...descendants.map((d) => String(d._id))];
}
