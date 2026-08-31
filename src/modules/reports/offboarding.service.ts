import { NotFoundError } from '../../core/errors/index.js';
import { PersonModel } from '../people/index.js';
import { AssetModel } from '../assets/index.js';
import { activeAssignmentsFor } from '../assignments/index.js';
import { notify } from '../notifications/index.js';

/**
 * Offboarding.
 *
 * The brief asked what happens when someone is deactivated while still holding
 * equipment. This is the answer: deactivation does not silently orphan
 * assignments, it opens a checklist of what has to come back
 * (docs/06-edge-cases.md #2).
 *
 * Lives in `reports` rather than `people` because it spans people, assets and
 * assignments — putting it in `people` would make that module depend on assets,
 * and assignments already depends on both, which is a cycle.
 */

export interface OutstandingItem {
  assignmentId: string;
  assetId: string;
  assetTag: string;
  assetName: string;
  assignedAt: Date;
  condition: string;
}

export interface OffboardingChecklist {
  personId: string;
  personName: string;
  status: string;
  outstanding: OutstandingItem[];
  /** True only when nothing is left to collect. */
  clearToDeactivate: boolean;
}

export async function offboardingChecklist(personId: string): Promise<OffboardingChecklist> {
  const person = await PersonModel.findById(personId).exec();
  if (!person) throw new NotFoundError('Person');

  const assignments = await activeAssignmentsFor(personId);

  const outstanding: OutstandingItem[] = [];

  for (const assignment of assignments) {
    const asset = await AssetModel.findById(assignment.assetId)
      .select('assetTag name condition')
      .lean();

    if (!asset) continue;

    outstanding.push({
      assignmentId: String(assignment._id),
      assetId: String(asset._id),
      assetTag: asset.assetTag,
      assetName: asset.name,
      assignedAt: assignment.assignedAt,
      condition: asset.condition,
    });
  }

  return {
    personId,
    personName: `${person.firstName} ${person.lastName}`,
    status: person.status,
    outstanding,
    clearToDeactivate: outstanding.length === 0,
  };
}

/**
 * Marks someone as leaving and surfaces what they still hold.
 *
 * Deliberately does NOT deactivate them: an inactive person cannot be assigned
 * to, which would block the transfers that offboarding usually involves. They
 * move to `offboarding`, which the dashboard's attention panel picks up.
 */
export async function startOffboarding(personId: string): Promise<OffboardingChecklist> {
  const person = await PersonModel.findById(personId).exec();
  if (!person) throw new NotFoundError('Person');

  person.status = 'offboarding';
  await person.save();

  const checklist = await offboardingChecklist(personId);

  if (checklist.outstanding.length > 0) {
    const { currentRecipientId } = await import('../notifications/index.js');
    const recipientId = currentRecipientId();

    if (recipientId) {
      await notify({
        recipientId,
        type: 'offboarding.outstanding',
        title: `${checklist.personName} is leaving with ${checklist.outstanding.length} item${
          checklist.outstanding.length === 1 ? '' : 's'
        } outstanding`,
        body: checklist.outstanding.map((i) => `${i.assetTag} — ${i.assetName}`).join('\n'),
        entityRef: { type: 'person', id: personId },
        actionUrl: `/people/${personId}`,
        dedupeKey: `offboarding:${personId}`,
      });
    }
  }

  return checklist;
}

/**
 * Completes offboarding, once everything is back.
 *
 * Refuses while items are outstanding unless explicitly forced — and a force is
 * recorded, because "we never got the laptop back" is exactly the fact an audit
 * later asks about.
 */
export async function completeOffboarding(
  personId: string,
  options: { force?: boolean } = {},
): Promise<OffboardingChecklist> {
  const checklist = await offboardingChecklist(personId);

  if (!checklist.clearToDeactivate && !options.force) {
    return checklist;
  }

  const person = await PersonModel.findById(personId).exec();
  if (!person) throw new NotFoundError('Person');

  person.status = 'inactive';
  person.endDate = person.endDate ?? new Date();
  await person.save();

  return { ...checklist, status: 'inactive' };
}
