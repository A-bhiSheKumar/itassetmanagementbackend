import type { Schema, Query, Aggregate } from 'mongoose';
import { getContext } from '../../context/index.js';

/**
 * Soft delete (docs/03-data-model.md §5).
 *
 * Adds `deletedAt`/`deletedBy` and excludes deleted documents from every read.
 * Hard deletion happens only through explicit, audited purge jobs.
 *
 * Every partial unique index in the schema layer excludes `deletedAt: null`, so
 * deleting an asset frees its tag and serial for reuse — which is what
 * customers expect and what a plain unique index would prevent.
 *
 * To include deleted rows (a trash view):
 *   Model.find(...).setOptions({ withDeleted: true })
 */

const READ_HOOKS = /^(find|count|distinct)/;
const WRITE_HOOKS = /^(update)/;

/**
 * The plugin is registered globally, so every document genuinely has these.
 * Declaring them once beats casting at every call site — and a cast would also
 * hide the day someone removes the plugin.
 */
declare module 'mongoose' {
  interface Document {
    softDelete(): Promise<this>;
    restore(): Promise<this>;
  }
}

interface SoftDeletable {
  deletedAt: Date | null;
  deletedBy: string | null;
  save(): Promise<unknown>;
}

function excludeDeleted(this: Query<unknown, unknown>): void {
  if (this.getOptions().withDeleted === true) return;

  const filter = this.getFilter();
  // Respect an explicit deletedAt condition — a trash view asks for deleted rows.
  if ('deletedAt' in filter) return;

  this.setQuery({ ...filter, deletedAt: null });
}

export function softDeletePlugin(schema: Schema): void {
  schema.add({
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null },
  });

  schema.pre(READ_HOOKS, excludeDeleted);
  schema.pre(WRITE_HOOKS, excludeDeleted);

  schema.pre('aggregate', function (this: Aggregate<unknown[]>) {
    const options = this.options as { withDeleted?: boolean } | undefined;
    if (options?.withDeleted === true) return;
    this.pipeline().unshift({ $match: { deletedAt: null } });
  });

  schema.methods.softDelete = function softDelete(this: SoftDeletable) {
    this.deletedAt = new Date();
    this.deletedBy = getContext()?.userId ?? null;
    return this.save();
  };

  schema.methods.restore = function restore(this: SoftDeletable) {
    this.deletedAt = null;
    this.deletedBy = null;
    return this.save();
  };
}
