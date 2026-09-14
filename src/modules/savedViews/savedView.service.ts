import { getContext } from '../../core/context/index.js';
import { UnauthenticatedError, NotFoundError, ValidationError } from '../../core/errors/index.js';
import { upsertWithRetry } from '../../core/db/index.js';
import { SavedViewModel, type SavedViewModule } from './savedView.model.js';

/** A person can keep this many views per screen before the chip row stops being scannable. */
export const MAX_VIEWS_PER_MODULE = 20;

function membershipId(): string {
  const id = getContext()?.membershipId;
  // A user-scoped token has no organisation chosen, so there is nothing to scope to.
  if (!id) throw new UnauthenticatedError('Choose an organisation first.');
  return id;
}

export function listViews(module: SavedViewModule) {
  return SavedViewModel.find({ membershipId: membershipId(), module }).sort({ name: 1 }).lean().exec();
}

/**
 * Saves under a name, replacing any view already called that.
 *
 * Upsert rather than insert-or-409: "save as 'Overdue laptops'" twice means the
 * operator wants the newer filters under that name, and making them delete the
 * old one first is ceremony, not safety.
 */
export async function saveView(module: SavedViewModule, name: string, query: string) {
  const owner = membershipId();
  const normalisedQuery = query.replace(/^\?/, '');

  const existing = await SavedViewModel.exists({ membershipId: owner, module, name }).exec();
  if (!existing) {
    const count = await SavedViewModel.countDocuments({ membershipId: owner, module }).exec();
    if (count >= MAX_VIEWS_PER_MODULE) {
      throw new ValidationError(`You can keep up to ${MAX_VIEWS_PER_MODULE} views on this screen. Delete one first.`);
    }
  }

  return upsertWithRetry(() =>
    SavedViewModel.findOneAndUpdate(
      { membershipId: owner, module, name },
      { $set: { query: normalisedQuery } },
      { upsert: true, new: true, runValidators: true },
    )
      .lean()
      .exec(),
  );
}

export async function deleteView(id: string): Promise<void> {
  // The membership filter is what stops one person deleting another's view by id.
  const result = await SavedViewModel.deleteOne({ _id: id, membershipId: membershipId() }).exec();
  if (result.deletedCount === 0) throw new NotFoundError('Saved view');
}
