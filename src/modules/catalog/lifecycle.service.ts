import { InvalidTransitionError, NotFoundError, PermissionDeniedError, ValidationError } from '../../core/errors/index.js';
import { getContextOrThrow } from '../../core/context/index.js';
import {
  LifecycleWorkflowModel,
  DEFAULT_WORKFLOW,
  type LifecycleWorkflowDocument,
} from './lifecycleWorkflow.model.js';

/**
 * The lifecycle engine (ADR-006).
 *
 * Every state change goes through `planTransition`. It answers one question —
 * is this move declared, permitted, and are its preconditions met? — and returns
 * the effects the caller must apply inside its transaction.
 *
 * The engine deliberately does NOT perform the effects itself. Unassigning an
 * asset belongs to the assignment service, which owns that invariant; the engine
 * telling it to happen keeps both concerns in one place each.
 */

export async function seedDefaultWorkflow(): Promise<LifecycleWorkflowDocument> {
  const existing = await LifecycleWorkflowModel.findOne({ isDefault: true }).exec();
  if (existing) return existing;

  return LifecycleWorkflowModel.create({
    ...DEFAULT_WORKFLOW,
    states: [...DEFAULT_WORKFLOW.states],
    transitions: [...DEFAULT_WORKFLOW.transitions],
  });
}

export async function getWorkflow(id?: string | null): Promise<LifecycleWorkflowDocument> {
  const workflow = id
    ? await LifecycleWorkflowModel.findById(id).exec()
    : await LifecycleWorkflowModel.findOne({ isDefault: true }).exec();

  if (!workflow) throw new NotFoundError('Lifecycle workflow');
  return workflow;
}

export interface TransitionContext {
  /** True when the asset currently has an active assignment. */
  hasActiveAssignment: boolean;
  /** Values available to satisfy `requiredFields`. */
  fields?: Record<string, unknown>;
  comment?: string;
}

export interface TransitionPlan {
  from: string;
  to: string;
  label: string;
  effects: string[];
  workflowVersion: number;
}

const GUARD_MESSAGES: Record<string, string> = {
  no_active_assignment:
    'This asset is still assigned. Return it first, then try again.',
  has_assignment: 'Assign this asset to someone before deploying it.',
  not_under_maintenance: 'Finish the open maintenance record first.',
};

/**
 * Validates a proposed state change and returns what the caller must do.
 *
 * Throws rather than returning a result object: every caller must handle a
 * refusal, and an ignored boolean is how invalid states get written.
 */
export async function planTransition(input: {
  workflowId?: string | null;
  from: string;
  to: string;
  context: TransitionContext;
}): Promise<TransitionPlan> {
  const workflow = await getWorkflow(input.workflowId);
  const actor = getContextOrThrow();

  const fromState = workflow.states.find((s) => s.key === input.from);
  const toState = workflow.states.find((s) => s.key === input.to);

  if (!toState) {
    throw new InvalidTransitionError(input.from, input.to, `"${input.to}" is not a state in this workflow.`);
  }

  if (fromState?.isTerminal) {
    throw new InvalidTransitionError(
      input.from,
      input.to,
      `"${fromState.label}" is a final state — nothing moves out of it.`,
    );
  }

  const transition = workflow.transitions.find((t) => t.from === input.from && t.to === input.to);

  if (!transition) {
    // Listing the legal moves turns a dead end into something the user can act
    // on, and makes a misconfigured workflow obvious rather than mysterious.
    const available = workflow.transitions
      .filter((t) => t.from === input.from)
      .map((t) => t.label);

    throw new InvalidTransitionError(
      input.from,
      input.to,
      available.length > 0
        ? `You can't go straight there. From "${fromState?.label ?? input.from}" you can: ${available.join(', ')}.`
        : `No moves are configured from "${fromState?.label ?? input.from}".`,
    );
  }

  if (transition.requiredPermission && !actor.permissions.has(transition.requiredPermission)) {
    throw new PermissionDeniedError(transition.requiredPermission);
  }

  for (const guard of transition.guards) {
    const failed =
      (guard === 'no_active_assignment' && input.context.hasActiveAssignment) ||
      (guard === 'has_assignment' && !input.context.hasActiveAssignment);

    if (failed) {
      throw new InvalidTransitionError(input.from, input.to, GUARD_MESSAGES[guard]);
    }
  }

  const missing = transition.requiredFields.filter((field) => {
    const value = input.context.fields?.[field];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    throw new ValidationError(
      `Fill in ${missing.join(', ')} before making this change.`,
      Object.fromEntries(missing.map((f) => [f, ['Required for this change.']])),
    );
  }

  if (transition.requiresComment && !input.context.comment?.trim()) {
    throw new ValidationError('Add a note explaining this change.', {
      comment: ['Required for this change.'],
    });
  }

  return {
    from: input.from,
    to: input.to,
    label: transition.label,
    effects: [...transition.effects],
    workflowVersion: workflow.version,
  };
}

/** Moves offered in the UI — computed server-side so the two cannot disagree. */
export async function availableTransitions(input: {
  workflowId?: string | null;
  from: string;
}): Promise<Array<{ to: string; label: string; requiresComment: boolean; requiredFields: string[] }>> {
  const workflow = await getWorkflow(input.workflowId);
  const actor = getContextOrThrow();

  return workflow.transitions
    .filter((t) => t.from === input.from)
    .filter((t) => !t.requiredPermission || actor.permissions.has(t.requiredPermission))
    .map((t) => ({
      to: t.to,
      label: t.label,
      requiresComment: t.requiresComment,
      requiredFields: [...t.requiredFields],
    }));
}
