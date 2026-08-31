import { AssetAlreadyAssignedError, NotFoundError, ValidationError } from '../../core/errors/index.js';
import { withTransaction } from '../../core/db/index.js';
import { getContext } from '../../core/context/index.js';
import { generateToken, hashToken } from '../../core/auth/index.js';
import { emit, flushOutbox } from '../../core/events/index.js';
import { AssetModel } from '../assets/index.js';
import { PersonModel } from '../people/index.js';
import { AssignmentModel, type AssignmentDocument } from './assignment.model.js';

/**
 * Assign, return, transfer.
 *
 * Every one of these writes the Assignment record, the asset's cached pointer
 * and the outbox event in a SINGLE transaction. That is what makes history and
 * state incapable of disagreeing: either all three land or none do.
 */

export interface AssignInput {
  assetId: string;
  assigneeType?: 'person' | 'location' | 'asset';
  assigneeId: string;
  dueAt?: string | null;
  notes?: string;
  requireAcknowledgement?: boolean;
  conditionOut?: string;
}

async function assertAssigneeExists(type: string, id: string): Promise<string> {
  if (type === 'person') {
    const person = await PersonModel.findById(id).select('firstName lastName status').lean();
    if (!person) throw new ValidationError('That person does not exist.', { assigneeId: ['Not found.'] });

    // Assigning to someone on their way out is almost always a mistake, and it
    // makes the offboarding checklist immediately wrong.
    if (person.status === 'inactive' || person.status === 'offboarding') {
      throw new ValidationError(
        'That person is leaving or has left. Assign it to someone active instead.',
        { assigneeId: ['Not an active person.'] },
      );
    }

    return `${person.firstName} ${person.lastName}`;
  }

  const asset = await AssetModel.findById(id).select('name').lean();
  if (!asset) throw new ValidationError('That record does not exist.', { assigneeId: ['Not found.'] });
  return asset.name;
}

/**
 * Translates the unique-index violation into something a user can act on.
 *
 * The duplicate key IS the concurrency control (ADR-005). Catching it here and
 * naming the current holder turns a database error into a useful answer, and a
 * "transfer instead?" affordance in the UI.
 */
async function toFriendlyConflict(assetId: string, err: unknown): Promise<never> {
  if ((err as { code?: number }).code !== 11000) throw err;

  const active = await AssignmentModel.findOne({ assetId, status: 'active' }).lean();

  throw new AssetAlreadyAssignedError({
    assetId,
    assignmentId: active ? String(active._id) : undefined,
    assigneeId: active?.assigneeId,
  });
}

export async function assignAsset(input: AssignInput): Promise<AssignmentDocument> {
  const assigneeType = input.assigneeType ?? 'person';

  const existing = await AssetModel.findById(input.assetId).exec();
  if (!existing) throw new NotFoundError('Asset');

  const assigneeName = await assertAssigneeExists(assigneeType, input.assigneeId);

  const acknowledgementToken = input.requireAcknowledgement ? generateToken() : null;
  let created: AssignmentDocument;

  try {
    await withTransaction(async (session) => {
      // Reloaded inside: withTransaction retries its callback, and a document
      // carried in from outside keeps mutated state from the rolled-back
      // attempt (see the note on withTransaction).
      const asset = await AssetModel.findById(input.assetId).session(session).exec();
      if (!asset) throw new NotFoundError('Asset');

      const [assignment] = await AssignmentModel.create(
        [
          {
            assetId: input.assetId,
            assigneeType,
            assigneeId: input.assigneeId,
            status: 'active',
            assignedBy: getContext()?.userId ?? null,
            assignedAt: new Date(),
            dueAt: input.dueAt ? new Date(input.dueAt) : null,
            conditionOut: input.conditionOut ?? asset.condition,
            notes: input.notes ?? '',
            acknowledgement: acknowledgementToken
              ? {
                  requiredAt: new Date(),
                  tokenHash: hashToken(acknowledgementToken),
                  method: 'link',
                }
              : {},
          },
        ],
        { session },
      );

      created = assignment!;

      // The cached pointer, written ONLY here and only inside this transaction.
      asset.currentAssignment = {
        assignmentId: String(assignment!._id),
        assigneeType,
        assigneeId: input.assigneeId,
        assignedAt: assignment!.assignedAt,
      } as never;

      // Deploying is the natural consequence of assigning. Left to a separate
      // call, estates drift into "assigned but still in stock".
      if (asset.lifecycleState === 'in_stock') asset.lifecycleState = 'deployed';

      await asset.save({ session });

      await emit(
        {
          type: 'asset.assigned',
          subjectId: String(asset._id),
          subjectType: 'asset',
          summary: `${asset.name} was assigned to ${assigneeName}`,
          // The holder is carried by relatedIds (machine-readable) and by the
          // summary (human-readable). A `changes` entry as well would be a
          // third representation of the same fact, and the three drifted:
          // transfer showed names while return showed a raw id.
          relatedIds: { assignmentId: String(assignment!._id), assigneeId: input.assigneeId },
        },
        session,
      );
    });
  } catch (err) {
    await toFriendlyConflict(input.assetId, err);
  }

  await flushOutbox();
  return created!;
}

export interface ReturnInput {
  assetId: string;
  condition?: string;
  notes?: string;
  returnedTo?: string | null;
}

export async function returnAsset(input: ReturnInput): Promise<AssignmentDocument> {
  const existing = await AssetModel.findById(input.assetId).exec();
  if (!existing) throw new NotFoundError('Asset');

  const active = await AssignmentModel.findOne({
    assetId: input.assetId,
    status: 'active',
  }).exec();

  if (!active) {
    throw new ValidationError('This asset is not currently assigned to anyone.', {
      assetId: ['Not assigned.'],
    });
  }

  const assignment = await withTransaction(async (session) => {
    const asset = await AssetModel.findById(input.assetId).session(session).exec();
    if (!asset) throw new NotFoundError('Asset');

    const assignment = await AssignmentModel.findOne({ assetId: input.assetId, status: 'active' })
      .session(session)
      .exec();

    if (!assignment) {
      throw new ValidationError('This asset is not currently assigned to anyone.', {
        assetId: ['Not assigned.'],
      });
    }

    assignment.status = 'returned';
    assignment.returnedAt = new Date();
    assignment.returnedTo = input.returnedTo ?? getContext()?.userId ?? null;
    assignment.conditionIn = input.condition ?? asset.condition;
    if (input.notes) assignment.notes = `${assignment.notes}\n${input.notes}`.trim();
    await assignment.save({ session });

    const previousAssignee = assignment.assigneeId;
    const previousName = await resolveAssigneeName(assignment.assigneeType, previousAssignee);

    asset.currentAssignment = null;
    // Condition recorded at check-in is the truth about the item now.
    if (input.condition) asset.condition = input.condition as never;
    if (asset.lifecycleState === 'deployed') asset.lifecycleState = 'in_stock';
    await asset.save({ session });

    await emit(
      {
        type: 'asset.returned',
        subjectId: String(asset._id),
        subjectType: 'asset',
        summary: `${asset.name} was returned by ${previousName}`,
        relatedIds: { assignmentId: String(assignment._id), assigneeId: previousAssignee },
        // Only genuine field edits appear as a diff. Who held it is in the
        // summary and relatedIds.
        changes: input.condition
          ? [{ field: 'condition', label: 'Condition', from: assignment.conditionOut, to: input.condition }]
          : [],
        comment: input.notes,
      },
      session,
    );

    return assignment;
  });

  await flushOutbox();
  return assignment;
}

/**
 * Transfer — one atomic operation, not a return followed by an assign.
 *
 * Two separate calls leave a window where the asset is unassigned, and a
 * failure between them leaves the estate wrong with nobody noticing. Doing it
 * in one transaction also gives the timeline a single, truthful entry.
 */
export async function transferAsset(input: {
  assetId: string;
  toAssigneeId: string;
  assigneeType?: 'person' | 'location' | 'asset';
  notes?: string;
  condition?: string;
}): Promise<AssignmentDocument> {
  const assigneeType = input.assigneeType ?? 'person';

  const existingAsset = await AssetModel.findById(input.assetId).exec();
  if (!existingAsset) throw new NotFoundError('Asset');

  const current = await AssignmentModel.findOne({ assetId: input.assetId, status: 'active' }).exec();
  if (!current) {
    throw new ValidationError('This asset is not assigned, so there is nothing to transfer.', {
      assetId: ['Not assigned.'],
    });
  }

  if (current.assigneeId === input.toAssigneeId) {
    throw new ValidationError('That person already holds this asset.', {
      toAssigneeId: ['Already the holder.'],
    });
  }

  const toName = await assertAssigneeExists(assigneeType, input.toAssigneeId);
  const fromName = await resolveAssigneeName(current.assigneeType, current.assigneeId);

  let created: AssignmentDocument;

  try {
    await withTransaction(async (session) => {
      const asset = await AssetModel.findById(input.assetId).session(session).exec();
      if (!asset) throw new NotFoundError('Asset');

      const previous = await AssignmentModel.findOne({ assetId: input.assetId, status: 'active' })
        .session(session)
        .exec();

      if (!previous) {
        throw new ValidationError('This asset is not assigned, so there is nothing to transfer.', {
          assetId: ['Not assigned.'],
        });
      }

      previous.status = 'returned';
      previous.returnedAt = new Date();
      previous.conditionIn = input.condition ?? asset.condition;
      await previous.save({ session });

      const [next] = await AssignmentModel.create(
        [
          {
            assetId: input.assetId,
            assigneeType,
            assigneeId: input.toAssigneeId,
            status: 'active',
            assignedBy: getContext()?.userId ?? null,
            assignedAt: new Date(),
            conditionOut: input.condition ?? asset.condition,
            notes: input.notes ?? '',
            previousAssignmentId: String(previous._id),
          },
        ],
        { session },
      );

      created = next!;

      asset.currentAssignment = {
        assignmentId: String(next!._id),
        assigneeType,
        assigneeId: input.toAssigneeId,
        assignedAt: next!.assignedAt,
      } as never;
      await asset.save({ session });

      await emit(
        {
          type: 'asset.transferred',
          subjectId: String(asset._id),
          subjectType: 'asset',
          summary: `${asset.name} was transferred from ${fromName} to ${toName}`,
          relatedIds: {
            assignmentId: String(next!._id),
            previousAssignmentId: String(previous._id),
            fromAssigneeId: previous.assigneeId,
            assigneeId: input.toAssigneeId,
          },
          comment: input.notes,
        },
        session,
      );
    });
  } catch (err) {
    await toFriendlyConflict(input.assetId, err);
  }

  await flushOutbox();
  return created!;
}

/**
 * Resolves a display name for an event summary.
 *
 * Summaries are rendered sentences and do embed names — that is what makes a
 * timeline readable. Under a GDPR erasure the summaries for an erased person
 * need redacting alongside the tombstone; the ADR-013 guarantee is that the
 * machine-readable reference in relatedIds survives, so history stays navigable
 * either way.
 */
async function resolveAssigneeName(type: string, id: string): Promise<string> {
  if (type === 'person') {
    const person = await PersonModel.findById(id).select('firstName lastName').lean();
    // A deleted person still has to render. The reference survives; the name
    // does not (ADR-013).
    return person ? `${person.firstName} ${person.lastName}` : 'a former holder';
  }

  const asset = await AssetModel.findById(id).select('name').lean();
  return asset?.name ?? 'a former holder';
}

/** Everything a person currently holds — the offboarding screen's core query. */
export function activeAssignmentsFor(assigneeId: string) {
  return AssignmentModel.find({ assigneeId, status: 'active' }).sort({ assignedAt: -1 }).exec();
}

/** Chain of custody for one asset. */
export function assignmentHistory(assetId: string) {
  return AssignmentModel.find({ assetId }).sort({ assignedAt: -1 }).exec();
}

export async function acknowledgeAssignment(token: string): Promise<AssignmentDocument> {
  const found = await AssignmentModel.findOne({
    'acknowledgement.tokenHash': hashToken(token),
    'acknowledgement.acknowledgedAt': null,
    status: 'active',
  }).exec();

  if (!found) throw new NotFoundError('Acknowledgement');

  const asset = await AssetModel.findById(found.assetId).select('name').lean();

  const assignment = await withTransaction(async (session) => {
    const doc = await AssignmentModel.findById(found._id).session(session).exec();
    if (!doc) throw new NotFoundError('Acknowledgement');

    doc.acknowledgement!.acknowledgedAt = new Date();
    await doc.save({ session });

    await emit(
      {
        type: 'asset.acknowledged',
        subjectId: assignment.assetId,
        subjectType: 'asset',
        summary: `${asset?.name ?? 'Asset'} receipt was acknowledged`,
        relatedIds: { assignmentId: String(doc._id), assigneeId: doc.assigneeId },
      },
      session,
    );

    return doc;
  });

  await flushOutbox();
  return assignment;
}
