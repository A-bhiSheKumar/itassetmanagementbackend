import { registerSubscriber } from './core/events/index.js';
import { timelineSubscriber } from './modules/timeline/index.js';
import { auditSubscriber } from './modules/auditlog/index.js';

/**
 * The composition root for event subscribers.
 *
 * Lives here rather than in core/events because core is framework and must not
 * import a module — a rule dependency-cruiser enforces. Both entrypoints call
 * this, so the API and the worker deliver events identically.
 *
 * Adding webhooks, search indexing or metric rollups later means one more line
 * here, not an edit to every service (ADR-007).
 */
export function registerEventSubscribers(): void {
  registerSubscriber(auditSubscriber);
  registerSubscriber(timelineSubscriber);
}
