/**
 * Domain events (ADR-007).
 *
 * Every state change worth knowing about is emitted here, inside the same
 * transaction as the change itself. Audit, timeline, notifications, webhooks,
 * search indexing and metric rollups are all subscribers — which is why adding
 * webhooks later is a new subscriber rather than an edit to twenty-five services.
 */

export const EVENT_TYPES = [
  'asset.created',
  'asset.updated',
  'asset.deleted',
  'asset.restored',
  'asset.assigned',
  'asset.returned',
  'asset.transferred',
  'asset.transitioned',
  'asset.acknowledged',
  'person.created',
  'person.deactivated',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** A single before/after pair, as shown on the timeline. */
export interface FieldChange {
  field: string;
  label: string;
  from: unknown;
  to: unknown;
}

export interface DomainEvent {
  type: EventType;
  /** The record the event is about — an asset id for every `asset.*` event. */
  subjectId: string;
  subjectType: 'asset' | 'person' | 'assignment';
  /** Human-readable one-liner for the timeline feed. */
  summary: string;
  changes?: FieldChange[];
  /** Ids of other records involved: assignee, previous holder, assignment. */
  relatedIds?: Record<string, string | null>;
  comment?: string;
  /** Anything a subscriber needs that is not display material. */
  payload?: Record<string, unknown>;
}
