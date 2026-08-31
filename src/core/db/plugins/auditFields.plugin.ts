import type { Schema, Document, Query } from 'mongoose';
import { getContext } from '../../context/index.js';

/**
 * Stamps createdBy/updatedBy from the ambient actor.
 *
 * These are actor REFERENCES, never copied names (ADR-013). Resolving the
 * display name at read time is what makes GDPR erasure possible without
 * destroying history — a tombstoned person still renders as
 * "Deleted user (ref …)" everywhere they appear.
 */

const UPDATE_HOOKS = /^(update|findOneAndUpdate)/;

export function auditFieldsPlugin(schema: Schema): void {
  schema.add({
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  });

  schema.pre(
    'save',
    function (this: Document & { createdBy?: string | null; updatedBy?: string | null }) {
      const actorId = getContext()?.userId ?? null;
      if (this.isNew) this.createdBy = this.createdBy ?? actorId;
      this.updatedBy = actorId;
    },
  );

  schema.pre(UPDATE_HOOKS, function (this: Query<unknown, unknown>) {
    this.set({ updatedBy: getContext()?.userId ?? null });
  });
}
