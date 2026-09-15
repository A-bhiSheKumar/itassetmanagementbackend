import { Schema, type InferSchemaType, type Model } from 'mongoose';
import { defineModel, type Scoped } from '../../core/db/index.js';

/**
 * A named filter set, per person, per screen.
 *
 * Stored as the raw URL query string rather than a structured filter object.
 * That is deliberate and it is what makes this cheap to own: every screen
 * already round-trips its filters through the URL, so any filter added to any
 * list later works in saved views on the day it ships, with no migration and no
 * change here.
 *
 * Scoped to the MEMBERSHIP, not the user — the same person in two organisations
 * has two unrelated sets of views, and a view naming a location id from one
 * tenant is meaningless in the other.
 */

/** The list screens that support saved views. A closed set, so a typo is a 422. */
export const SAVED_VIEW_MODULES = ['assets', 'assignments', 'people', 'audit', 'maintenance', 'licences', 'vendors'] as const;
export type SavedViewModule = (typeof SAVED_VIEW_MODULES)[number];

const savedViewSchema = new Schema(
  {
    membershipId: { type: String, required: true },
    module: { type: String, required: true, enum: SAVED_VIEW_MODULES },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    /** `status=active&type=abc`, without the leading `?`. */
    query: { type: String, default: '', maxlength: 2000 },
  },
  { timestamps: true },
);

// One name per person per screen; saving under an existing name replaces it.
// Doubles as the index for listing a screen's views.
savedViewSchema.index({ tenantId: 1, membershipId: 1, module: 1, name: 1 }, { unique: true });

export type SavedView = Scoped<InferSchemaType<typeof savedViewSchema>>;

export const SavedViewModel = defineModel('SavedView', savedViewSchema) as unknown as Model<SavedView>;
