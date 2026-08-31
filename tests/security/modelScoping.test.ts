import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';

// Importing the app compiles every model, exactly as production does.
import '../../src/app.js';

/**
 * Every model is tenant-scoped unless it is on the explicit exemption list.
 *
 * ── Why this test exists ───────────────────────────────────────────────────
 * Global plugins are applied when a model is COMPILED. Models compile at import
 * time; `registerGlobalPlugins()` originally ran inside connectDatabase(), long
 * after `import { createApp }` had already compiled them. Result: not one model
 * had a tenantId, and every query ran unscoped — silently, because an unscoped
 * query returns rows and looks like it worked.
 *
 * It surfaced only because a unique index happened to collide during seeding.
 * That is far too much luck to rely on, so this asserts the invariant directly.
 */

/**
 * The complete list of models that legitimately span tenants.
 *
 * Adding to it must be a deliberate, reviewed decision — every entry is a place
 * where tenant isolation does not apply, and the reason is recorded here.
 */
const GLOBAL_MODELS: Record<string, string> = {
  User: 'A login identity exists before, and independently of, any tenant (ADR-003).',
  RefreshToken: 'Issued at login, before a tenant has been selected.',
  Tenant: 'Defines the tenant, so it cannot be scoped by one.',
  Plan: 'Platform-wide commercial reference data.',
};

/**
 * Fixture models defined inside plugin tests. With `isolate: false` they share
 * the mongoose registry, so they turn up here too. Prefixed rather than filtered
 * by an allowlist, so a real model can never be excluded by accident.
 */
const isFixture = (name: string) => name.startsWith('Test');

describe('model tenant scoping', () => {
  const modelNames = Object.keys(mongoose.models).filter((n) => !isFixture(n)).sort();

  it('compiled the models', () => {
    expect(modelNames.length).toBeGreaterThan(5);
  });

  it.each(modelNames)('%s is scoped or explicitly global', (name) => {
    const schema = mongoose.models[name]!.schema;
    const hasTenantId = schema.path('tenantId') !== undefined;

    if (name in GLOBAL_MODELS) {
      expect(
        hasTenantId,
        `${name} is listed as global but has a tenantId path. Remove it from ` +
          'GLOBAL_MODELS, or stop calling markSchemaGlobal() on it.',
      ).toBe(false);
      return;
    }

    expect(
      hasTenantId,
      `${name} has no tenantId path, so every query against it spans tenants. ` +
        'Either it must be tenant-scoped, or it belongs in GLOBAL_MODELS with a reason.',
    ).toBe(true);

    expect(schema.path('tenantId')!.isRequired).toBe(true);
  });

  /**
   * Global plugins must NOT reach embedded schemas.
   *
   * Mongoose applies them to child schemas by default, which gave every nested
   * object — a select field's options, a lifecycle state, an address — its own
   * required, immutable `tenantId`, plus `deletedAt` and `createdBy`. Invisible
   * on insert; then any later assignment to the parent path fails with
   * "Path `tenantId` is immutable". It is also conceptually wrong: a
   * subdocument inherits its parent's tenant and has nothing to scope.
   */
  it('keeps tenant and audit fields out of embedded subdocuments', () => {
    const polluted: string[] = [];

    for (const name of modelNames) {
      const schema = mongoose.models[name]!.schema;

      for (const pathName of Object.keys(schema.paths)) {
        const child = (schema.path(pathName) as unknown as { schema?: mongoose.Schema }).schema;
        if (!child) continue;

        for (const field of ['tenantId', 'deletedAt', 'createdBy', 'updatedBy']) {
          if (child.path(field)) polluted.push(`${name}.${pathName}.${field}`);
        }
      }
    }

    expect(
      polluted,
      'Global plugins leaked into embedded schemas. Check ' +
        "mongoose.set('applyPluginsToChildSchemas', false) in core/db/connection.ts.",
    ).toEqual([]);
  });

  it('never lets a global model carry a unique index over a tenant field', () => {
    for (const name of Object.keys(GLOBAL_MODELS)) {
      const schema = mongoose.models[name]?.schema;
      if (!schema) continue;

      for (const [fields] of schema.indexes()) {
        expect(Object.keys(fields)).not.toContain('tenantId');
      }
    }
  });

  /**
   * Fields that are legitimately unique across ALL tenants.
   *
   * Every entry is a high-entropy secret that IS the lookup key, consulted
   * before any tenant context exists — you cannot scope the query that resolves
   * an invitation link by the tenant the link belongs to. Collisions are
   * cryptographically improbable, and global uniqueness is what makes the
   * lookup a single indexed hit.
   *
   * Nothing user-supplied belongs here. An email, a serial number or an asset
   * tag made globally unique would let one customer's data block another's.
   */
  const GLOBALLY_UNIQUE_FIELDS = new Set(['tokenHash']);

  it('prefixes every tenant-scoped unique index with tenantId', () => {
    for (const name of modelNames) {
      if (name in GLOBAL_MODELS) continue;

      for (const [fields, options] of mongoose.models[name]!.schema.indexes()) {
        if (!options?.unique) continue;

        const first = Object.keys(fields)[0]!;
        if (GLOBALLY_UNIQUE_FIELDS.has(first) && Object.keys(fields).length === 1) continue;

        // A unique index that does not lead with tenantId makes one customer's
        // serial number, asset tag or email collide with another's.
        expect(
          first,
          `${name} has a unique index ${JSON.stringify(fields)} that does not start ` +
            'with tenantId. It would enforce uniqueness across every customer. If the ' +
            'field is a high-entropy secret looked up before a tenant is known, add it ' +
            'to GLOBALLY_UNIQUE_FIELDS with a reason.',
        ).toBe('tenantId');
      }
    }
  });
});
