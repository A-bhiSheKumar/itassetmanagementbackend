import type { Model } from 'mongoose';
import { NotFoundError, ResourceInUseError, ValidationError } from '../../core/errors/index.js';
import { getContext } from '../../core/context/index.js';
import { assertWithinLimit, incrementUsage } from '../subscriptions/index.js';
import { compileFieldSchema, definitionsFor, flattenCustomFields } from '../catalog/index.js';
import { PersonModel, buildSearchTokens, type PersonDocument } from './person.model.js';
import { ORG_UNIT_MODELS, type OrgUnit, type OrgUnitKind } from './orgUnit.model.js';
import { resolvePath, assertNoCycle, rewriteDescendantPaths, subtreeIds } from './hierarchy.js';

/**
 * Applies the scope of a department- or location-limited role.
 *
 * The SAME filter is used for list queries and for record-level checks, so a
 * scoped Manager's list and their detail access can never disagree — the
 * classic version of that bug shows a row the user then cannot open.
 */
export async function scopeFilter(): Promise<Record<string, unknown>> {
  const scope = getContext()?.scope;
  if (!scope || scope.type === 'all') return {};

  if (scope.type === 'department' && scope.departmentIds?.length) {
    // Subtree, not just the named nodes: scoping someone to "Engineering"
    // must include the teams beneath it.
    const ids = await subtreeIds(ORG_UNIT_MODELS.department, scope.departmentIds);
    return { departmentId: { $in: ids } };
  }

  if (scope.type === 'location' && scope.locationIds?.length) {
    const ids = await subtreeIds(ORG_UNIT_MODELS.location, scope.locationIds);
    return { locationId: { $in: ids } };
  }

  return {};
}

export interface ListPeopleOptions {
  status?: string;
  departmentId?: string;
  locationId?: string;
  q?: string;
  limit: number;
  cursor?: string;
}

/**
 * Cursor pagination over `{tenantId, createdAt, _id}` (ADR-010).
 *
 * Offset paging makes Mongo walk every skipped document, and results shift
 * under concurrent writes. A cursor is constant-time at any depth and stable.
 */
export async function listPeople(options: ListPeopleOptions): Promise<{
  items: PersonDocument[];
  cursor: string | null;
  hasMore: boolean;
}> {
  const filter: Record<string, unknown> = { ...(await scopeFilter()) };

  if (options.status) filter.status = options.status;
  if (options.departmentId) filter.departmentId = options.departmentId;
  if (options.locationId) filter.locationId = options.locationId;
  if (options.q) filter.searchTokens = new RegExp(`^${escapeRegExp(options.q.toLowerCase())}`);

  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (decoded) {
      filter.$or = [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, _id: { $lt: decoded.id } },
      ];
    }
  }

  // One extra row tells us whether another page exists without a second query.
  const rows = await PersonModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(options.limit + 1)
    .exec();

  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    hasMore,
    cursor: hasMore && last ? encodeCursor(last.createdAt as Date, String(last._id)) : null,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt.toISOString(), i: id })).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { c: string; i: string };
    return { createdAt: new Date(parsed.c), id: parsed.i };
  } catch {
    // A malformed cursor is a client bug, not a reason to fail the request —
    // returning page one is the recoverable behaviour.
    return null;
  }
}

export async function findPerson(id: string): Promise<PersonDocument> {
  const person = await PersonModel.findOne({ _id: id, ...(await scopeFilter()) }).exec();
  if (!person) throw new NotFoundError('Person');
  return person;
}

export interface PersonInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  employeeCode?: string | null;
  phone?: string | null;
  jobTitle?: string;
  departmentId?: string | null;
  locationId?: string | null;
  costCentreId?: string | null;
  managerId?: string | null;
  type?: string;
  startDate?: string | null;
  customFields?: Record<string, unknown>;
}

/**
 * Validates and stores custom field values.
 *
 * Two behaviours that are easy to get wrong, and were:
 *
 * 1. On CREATE the compiler always runs, even with no values supplied.
 *    Skipping it when `customFields` is absent lets a client bypass every
 *    required field simply by omitting the key.
 *
 * 2. On UPDATE the supplied values are MERGED over the existing ones before
 *    validating. Parsing only what was sent would silently wipe every field the
 *    request did not mention — PATCH means "change these", not "replace all".
 *    Merging first also means `required` is evaluated against the result.
 */
async function applyCustomFields(
  person: PersonDocument,
  input: Record<string, unknown> | undefined,
  mode: 'create' | 'update',
): Promise<void> {
  if (mode === 'update' && input === undefined) return;

  const definitions = await definitionsFor({ appliesTo: 'person' });

  const merged =
    mode === 'update'
      ? { ...flattenCustomFields(person.cf as never), ...(input ?? {}) }
      : (input ?? {});

  person.cf = compileFieldSchema(definitions).parse(merged) as never;
}

export async function createPerson(input: PersonInput): Promise<PersonDocument> {
  await assertWithinLimit('people');
  await assertReferencesExist(input);

  const person = new PersonModel({
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email || null,
    employeeCode: input.employeeCode || null,
    phone: input.phone || null,
    jobTitle: input.jobTitle ?? '',
    departmentId: input.departmentId || null,
    locationId: input.locationId || null,
    costCentreId: input.costCentreId || null,
    managerId: input.managerId || null,
    type: input.type ?? 'employee',
    startDate: input.startDate ? new Date(input.startDate) : null,
    searchTokens: buildSearchTokens(input),
  });

  await applyCustomFields(person, input.customFields, 'create');
  await person.save();
  await incrementUsage('people');

  return person;
}

export async function updatePerson(id: string, input: Partial<PersonInput>): Promise<PersonDocument> {
  const person = await findPerson(id);
  await assertReferencesExist(input, id);

  for (const key of [
    'firstName', 'lastName', 'phone', 'jobTitle', 'departmentId',
    'locationId', 'costCentreId', 'managerId', 'type',
  ] as const) {
    if (input[key] !== undefined) (person as never as Record<string, unknown>)[key] = input[key];
  }

  // Empty string means "clear it", which must become null so the partial unique
  // index keeps ignoring the field rather than colliding on "".
  if (input.email !== undefined) person.email = input.email || null;
  if (input.employeeCode !== undefined) person.employeeCode = input.employeeCode || null;
  if (input.startDate !== undefined) person.startDate = input.startDate ? new Date(input.startDate) : null;

  await applyCustomFields(person, input.customFields, 'update');

  person.searchTokens = buildSearchTokens({
    firstName: person.firstName,
    lastName: person.lastName,
    email: person.email,
    employeeCode: person.employeeCode,
    jobTitle: person.jobTitle,
  });

  await person.save();
  return person;
}

/**
 * Rejects references to records that do not exist or belong elsewhere.
 *
 * Mongo has no foreign keys, so this is layer one of the three that stand in
 * for them (docs/03-data-model.md §6). Every id here arrives from a request
 * body and is therefore untrusted.
 */
async function assertReferencesExist(input: Partial<PersonInput>, selfId?: string): Promise<void> {
  const checks: Array<[string, string | null | undefined, Model<never>]> = [
    ['departmentId', input.departmentId, ORG_UNIT_MODELS.department as never],
    ['locationId', input.locationId, ORG_UNIT_MODELS.location as never],
    ['costCentreId', input.costCentreId, ORG_UNIT_MODELS.costCentre as never],
  ];

  const fields: Record<string, string[]> = {};

  for (const [field, value, model] of checks) {
    if (!value) continue;
    const exists = await (model as unknown as Model<unknown>).countDocuments({ _id: value });
    if (exists === 0) fields[field] = ['That record does not exist.'];
  }

  if (input.managerId) {
    if (selfId && input.managerId === selfId) {
      fields.managerId = ['Someone cannot manage themselves.'];
    } else {
      const exists = await PersonModel.countDocuments({ _id: input.managerId });
      if (exists === 0) fields.managerId = ['That person does not exist.'];
      else if (selfId && (await createsManagerCycle(selfId, input.managerId))) {
        fields.managerId = ['That would create a reporting loop.'];
      }
    }
  }

  if (Object.keys(fields).length > 0) {
    throw new ValidationError('Some of those references are not valid.', fields);
  }
}

/** Walks up the reporting chain. A cycle makes every org-chart query hang. */
async function createsManagerCycle(personId: string, managerId: string): Promise<boolean> {
  let current: string | null = managerId;

  // Bounded: a corrupt chain must terminate rather than spin. 50 levels is far
  // beyond any real reporting line.
  for (let depth = 0; current && depth < 50; depth += 1) {
    if (current === personId) return true;

    // Annotated explicitly: inferring it from a query built with `current`,
    // then assigning back into `current`, is circular as far as TS is concerned.
    const next: { managerId: string | null } | null = await PersonModel.findById(current)
      .select('managerId')
      .lean<{ managerId: string | null } | null>();

    current = next?.managerId ?? null;
  }

  return false;
}

/**
 * Deactivation.
 *
 * Once assignments exist (M3) this refuses while the person still holds
 * equipment and opens an offboarding record instead (docs/06-edge-cases.md #2).
 * The seam is here so that behaviour is added in one place.
 */
export async function deactivatePerson(id: string): Promise<PersonDocument> {
  const person = await findPerson(id);
  const reports = await PersonModel.countDocuments({ managerId: id, status: 'active' });

  person.status = 'inactive';
  person.endDate = person.endDate ?? new Date();
  await person.save();
  await incrementUsage('people', -1);

  // Not blocked: making offboarding a chain reaction across a whole reporting
  // line would be worse than a flagged record someone reassigns.
  if (reports > 0) {
    person.set('_warning', `${reports} people still report to this person.`);
  }

  return person;
}

export async function deletePerson(id: string): Promise<void> {
  const person = await findPerson(id);

  const reports = await PersonModel.countDocuments({ managerId: id, deletedAt: null });
  if (reports > 0) {
    throw new ResourceInUseError('person', [{ type: 'direct report', count: reports }]);
  }

  await person.softDelete();
  await incrementUsage('people', -1);
}

// ── Org units ──────────────────────────────────────────────────────────────

export function listOrgUnits(kind: OrgUnitKind) {
  return ORG_UNIT_MODELS[kind].find({}).sort({ name: 1 }).exec();
}

export async function createOrgUnit(kind: OrgUnitKind, input: Record<string, unknown>) {
  const model = ORG_UNIT_MODELS[kind];
  const parentId = (input.parentId as string | null) ?? null;

  return model.create({
    ...input,
    parentId,
    path: await resolvePath(model, parentId),
  } as Partial<OrgUnit>);
}

export async function updateOrgUnit(kind: OrgUnitKind, id: string, input: Record<string, unknown>) {
  const model = ORG_UNIT_MODELS[kind];

  const unit = await model.findById(id).exec();
  if (!unit) throw new NotFoundError('Record');

  const movingTo = input.parentId as string | null | undefined;

  if (movingTo !== undefined && movingTo !== unit.parentId) {
    await assertNoCycle(model, id, movingTo);

    const oldPath = [...unit.path];
    const newPath = await resolvePath(model, movingTo);

    unit.parentId = movingTo;
    unit.path = newPath;
    Object.assign(unit, omit(input, ['parentId', 'path']));
    await unit.save();

    await rewriteDescendantPaths(model, id, oldPath, newPath);
    return unit;
  }

  Object.assign(unit, omit(input, ['parentId', 'path']));
  await unit.save();
  return unit;
}

export async function deleteOrgUnit(kind: OrgUnitKind, id: string): Promise<void> {
  const unit = await ORG_UNIT_MODELS[kind].findById(id).exec();
  if (!unit) throw new NotFoundError('Record');

  const children = await ORG_UNIT_MODELS[kind].countDocuments({ parentId: id });
  const field = kind === 'department' ? 'departmentId' : kind === 'location' ? 'locationId' : 'costCentreId';
  const people = await PersonModel.countDocuments({ [field]: id });

  // Blocked with the actual counts, not a generic refusal — the user needs to
  // know what to reassign (docs/06-edge-cases.md #12).
  if (children > 0 || people > 0) {
    throw new ResourceInUseError(kind, [
      ...(children > 0 ? [{ type: 'child record', count: children }] : []),
      ...(people > 0 ? [{ type: 'person', count: people }] : []),
    ]);
  }

  await unit.softDelete();
}

function omit(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([k]) => !keys.includes(k)));
}
