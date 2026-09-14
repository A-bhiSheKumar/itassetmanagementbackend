import {
  PersonModel,
  ORG_UNIT_MODELS,
  deleteOrgUnit,
  listOrgUnits,
  type OrgUnitKind,
} from '../people/index.js';
import { AssetModel } from '../assets/index.js';
import { withTransaction } from '../../core/db/index.js';
import { emit, flushOutbox } from '../../core/events/index.js';
import { AppError, ErrorCode, NotFoundError, ResourceInUseError } from '../../core/errors/index.js';

/**
 * Where people and assets sit — locations, departments and cost centres.
 *
 * The units themselves live in the people module, which assets already depend
 * on. Anything that needs to know about BOTH people and assets — how many of
 * each a unit holds, whether it can be deleted, moving everything out of it —
 * lives here, above both, so neither module has to point back at the other.
 */

const PERSON_FIELD: Record<OrgUnitKind, string> = {
  department: 'departmentId',
  location: 'locationId',
  costCentre: 'costCentreId',
};

/** Assets are placed by location and department; cost centres are a people concept. */
const ASSET_FIELD: Partial<Record<OrgUnitKind, string>> = {
  department: 'placement.departmentId',
  location: 'placement.locationId',
};

const ASSET_LABEL: Partial<Record<OrgUnitKind, string>> = {
  department: 'Department',
  location: 'Location',
};

/** Assets moved per transaction — the same batch size imports commit with. */
const MOVE_BATCH = 500;

async function countBy(model: typeof PersonModel | typeof AssetModel, field: string): Promise<Map<string, number>> {
  const rows = await (model as typeof AssetModel).aggregate<{ _id: string; n: number }>([
    { $match: { [field]: { $type: 'string' } } },
    { $group: { _id: `$${field}`, n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.n]));
}

/**
 * Every unit, with how many people and assets sit DIRECTLY in it.
 *
 * Direct counts only: the client has each unit's path, so it can roll counts
 * up a tree without a second query — and a direct count is the number that
 * matters when deciding whether a unit can be deleted.
 */
export async function listUnitsWithCounts(kind: OrgUnitKind) {
  const assetField = ASSET_FIELD[kind];

  const [units, people, assets] = await Promise.all([
    listOrgUnits(kind),
    countBy(PersonModel, PERSON_FIELD[kind]),
    assetField ? countBy(AssetModel, assetField) : Promise.resolve(new Map<string, number>()),
  ]);

  return units.map((unit) => ({
    unit,
    peopleCount: people.get(String(unit._id)) ?? 0,
    assetCount: assets.get(String(unit._id)) ?? 0,
  }));
}

/**
 * Deletes a unit nothing refers to.
 *
 * The people module already refuses when people or child units point here.
 * Assets are checked first, because a location deleted out from under forty
 * laptops leaves them placed nowhere, with no way to tell where they were.
 */
export async function deleteUnit(kind: OrgUnitKind, id: string): Promise<void> {
  const field = ASSET_FIELD[kind];

  if (field) {
    const [children, people, assets] = await Promise.all([
      ORG_UNIT_MODELS[kind].countDocuments({ parentId: id }),
      PersonModel.countDocuments({ [PERSON_FIELD[kind]]: id }),
      AssetModel.countDocuments({ [field]: id }),
    ]);

    if (assets > 0) {
      throw new ResourceInUseError(kind === 'costCentre' ? 'cost centre' : kind, [
        ...(children > 0 ? [{ type: 'child record', count: children }] : []),
        ...(people > 0 ? [{ type: 'person', count: people }] : []),
        { type: 'asset', count: assets },
      ]);
    }
  }

  await deleteOrgUnit(kind, id);
}

/**
 * Moves every person and asset out of one unit and into another.
 *
 * The office-move case: "Leeds is closing, everything goes to Manchester". It
 * is also the way out of a refused delete, so the refusal is never a dead end.
 *
 * Each asset records the move on its own timeline, because "why does this say
 * Manchester?" is asked about one asset, months later. Assets move in batches
 * so a large site does not become one transaction too big to commit.
 */
export async function moveContents(
  kind: OrgUnitKind,
  fromId: string,
  toId: string,
): Promise<{ people: number; assets: number }> {
  if (fromId === toId) {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'Choose somewhere different to move them to.', {
      fields: { toId: ['Must be a different one.'] },
    });
  }

  const model = ORG_UNIT_MODELS[kind];
  const [from, to] = await Promise.all([model.findById(fromId).exec(), model.findById(toId).exec()]);
  if (!from) throw new NotFoundError('Record');
  if (!to) throw new NotFoundError('Destination');

  if (to.status === 'archived') {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, `${to.name} is archived. Restore it before moving anything into it.`, {
      fields: { toId: ['Archived.'] },
    });
  }

  const moved = await PersonModel.updateMany({ [PERSON_FIELD[kind]]: fromId }, { $set: { [PERSON_FIELD[kind]]: toId } });

  const field = ASSET_FIELD[kind];
  let assets = 0;

  if (field) {
    for (;;) {
      const batch = await withTransaction(async (session) => {
        const rows = await AssetModel.find({ [field]: fromId })
          .select('_id name')
          .limit(MOVE_BATCH)
          .session(session)
          .lean<Array<{ _id: unknown; name: string }>>();

        if (rows.length === 0) return 0;

        const ids = rows.map((r) => r._id);
        await AssetModel.updateMany({ _id: { $in: ids } }, { $set: { [field]: toId }, $inc: { __v: 1 } }, { session });

        for (const row of rows) {
          await emit(
            {
              type: 'asset.updated',
              subjectId: String(row._id),
              subjectType: 'asset',
              summary: `${row.name} moved from ${from.name} to ${to.name}`,
              changes: [{ field, label: ASSET_LABEL[kind]!, from: from.name, to: to.name }],
            },
            session,
          );
        }

        return rows.length;
      });

      await flushOutbox();
      assets += batch;
      if (batch < MOVE_BATCH) break;
    }
  }

  return { people: moved.modifiedCount, assets };
}
