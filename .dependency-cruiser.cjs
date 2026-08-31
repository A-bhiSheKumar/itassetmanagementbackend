/**
 * Module boundaries, enforced in CI (ADR-008).
 *
 * A modular monolith only stays modular if the boundaries are mechanical.
 * These rules are the difference between "we can extract a service in days"
 * and "we can never extract anything".
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies mean the boundary is already gone.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'modules-via-index-only',
      severity: 'error',
      comment:
        'Modules talk to each other through index.ts. Reaching into another module’s ' +
        'internals couples them permanently.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/(?!index\\.ts$).+',
        pathNot: '^src/modules/$1/',
      },
    },
    {
      name: 'core-never-imports-modules',
      severity: 'error',
      comment: 'core/ is framework. If core needs a module, the dependency is backwards.',
      from: { path: '^src/core/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'shared-is-pure',
      severity: 'error',
      comment: 'shared/ holds value types and utils only — no business logic, no I/O.',
      from: { path: '^src/shared/' },
      to: { path: '^src/(modules|core)/' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: { orphan: true, pathNot: '\\.d\\.ts$' },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
