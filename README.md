# Backend — IT Asset Management API

Node · Express · TypeScript · MongoDB (Mongoose) · Redis · BullMQ

Architecture and rationale: [`docs/`](docs/). Read
[`02-architecture.md`](docs/02-architecture.md) before adding a module.

The React client lives in a separate repository: [itassetmanagementfrontend](https://github.com/A-bhiSheKumar/itassetmanagementfrontend).

---

## Running it

```bash
npm install
cp .env.example .env        # the defaults work against docker compose
npm run infra:up            # Mongo (replica set), Redis, MinIO
npm run dev                 # API   → http://localhost:4000
npm run dev:worker          # Worker (same codebase, different entrypoint)
```

No Docker? `npm run dev:ephemeral` starts the API against a throwaway in-memory
replica set. Data is discarded on exit — fine for a look around, not a substitute
for real infrastructure. `PORT=4100 npm run dev:ephemeral` if 4000 is taken.

**Mongo must run as a replica set.** `docker-compose.yml` sets this up. Multi-document
transactions are load-bearing — assignment exclusivity, import commits — and a standalone
`mongod` accepts the connection then fails the first transaction at runtime.
`assertTransactionsSupported()` checks this at boot rather than letting you find out later.

Tests need no infrastructure: they start their own in-memory replica set.

| Command | |
|---|---|
| `npm test` | Full suite |
| `npm run typecheck` | |
| `npm run lint` | ESLint, including the module-boundary rules |
| `npm run lint:boundaries` | dependency-cruiser |
| `npm run build` | Compile to `dist/` |

---

## Layout

```
src/
  main.ts          API entrypoint
  worker.ts        Worker entrypoint — same modules, job processors instead of routes
  app.ts           Express wiring: helmet, CORS, context, routes, error handler
  routes.ts        The route table (isolation + permission test suites generate from this)
  config/          Env schema, validated at boot
  core/            Framework. Owned by nobody, used by everybody.
    context/       AsyncLocalStorage request context        ← tenant isolation, layer 1
    db/            Connection, global plugins, transactions ← tenant isolation, layer 2
    errors/        AppError taxonomy → API error codes
    http/          Response envelope, middleware
    logging/       pino, with tenant/request correlation
    validation/    Zod helpers — strict by default
  modules/         Business domains. Each owns its routes, service, repository, model.
  shared/          Pure value types and utils. No I/O, no business logic.
```

---

## Three rules that are not negotiable

**1. Every query is tenant-scoped, automatically.**
`core/db/plugins/tenantScope.plugin.ts` injects `tenantId` into every read, write and
aggregation from the ambient context. With no tenant in context it **throws** — it does not
return an unfiltered result. An unfiltered query returns every customer's data and looks
like it worked, which is exactly how these leaks reach production. Cross-tenant reads go
through `withoutTenantScope(reason, fn)`, which ESLint restricts to `modules/platform/`.

**2. Modules talk through `index.ts`.**
Reaching into another module's model, repository or service is a lint error and a
dependency-cruiser failure. This is what keeps a future service extraction a days-long job
rather than an impossible one.

**3. Controllers hold no logic.**
Parse, call the service, map the response. Repositories are the only code that touches
Mongoose. Services never see `req`/`res`.

---

## Gotchas worth knowing before you hit them

**Mongoose queries are lazy.** `runWithContext(ctx, () => Asset.find({}))` builds the query
inside the context and executes it *outside*, so the tenant filter finds nothing and throws.
Await inside the callback. `runAsSystem`, `withoutTenantScope` and the test helpers already
do; request handlers are safe automatically because the middleware wraps the whole chain.

**`pre('save')` runs after validation.** Mongoose registers validation as its own internal
pre-save hook before any plugin's, so stamping a required field in `pre('save')` lands after
`required: true` has already failed. The tenant plugin stamps in `pre('validate')` and
re-checks in `pre('save')`.

**A `pre('insertMany')` hook that declares `next` must call it.** Mongoose inspects
`fn.length`; forget the call and every `insertMany` hangs until the test timeout.

**Global plugins reach EMBEDDED schemas unless you stop them.** By default every nested
object — a select field's options, a lifecycle state, an address — got its own required,
immutable `tenantId`, plus `deletedAt` and `createdBy`. Invisible on insert, then any later
assignment to the parent path fails with "Path `tenantId` is immutable". It is also
conceptually wrong: a subdocument inherits its parent's tenant. Fixed by
`mongoose.set('applyPluginsToChildSchemas', false)` — which must be a global setting, set
before the plugins register; passing it as a plugin option is silently ignored.

**Global plugins apply at model COMPILE time, which is import time.** Registering them
inside `connectDatabase()` was too late — `import { createApp }` had already compiled every
model, so not one had a `tenantId` and every query ran unscoped. Plugins now register as a
side effect of importing `core/db`, every model goes through `defineModel()`, and
`tests/security/modelScoping.test.ts` asserts the invariant directly.

**`session.withTransaction()` ALREADY retries.** It implements the driver-spec retry loop for
TransientTransactionError and UnknownTransactionCommitResult, for up to 120 seconds. Wrapping
it in a retry loop of our own multiplied that into a six-minute worst case for a single HTTP
request. It surfaced as intermittently hanging tests — the polite version of what it would do
in production. There is no outer loop now, and `maxCommitTimeMS` bounds the commit.

**Concurrent upserts on a unique index race.** When several upserts target the same MISSING
document, MongoDB lets one insert and returns E11000 to the rest; the documented remedy is to
retry. The first burst of asset creations in a fresh tenant all race to create the same tag
counter — exactly what a bulk import does — so most of the batch failed with a duplicate-key
error about a document the user has never heard of. `upsertWithRetry()` in `core/db` wraps
every upsert on a unique index.

**Body parsers drain the request stream.** `express.urlencoded()` claims form-encoded
content by default, so a raw-upload endpoint that reads `req` itself gets nothing whenever a
client sends no explicit Content-Type — and stores an empty file without erroring. The
parsers now skip `PUT /documents/upload`. Worth noting *how* this was found: the supertest
tests passed, because they set `Content-Type: application/octet-stream`. Only driving the
real server with curl exposed it.

**Type a helper by the schema, not by an unrelated document type.** `defineModel<T>(name,
schema): Model<T>` made every call site infer `Model<unknown>` — silently losing every
document type — and sent `tsc` into an inference explosion that exhausted an 8 GB heap.
`defineModel<TSchema extends Schema>(name, schema)` gives real types and compiles instantly.

**Resolve permissions inside an explicit tenant context.** The auth middleware runs before
the request has a tenant, so the role lookup needs one built from the verified token. Getting
this wrong threw — which is the argument for a plugin that fails loudly: a silent-empty-filter
design would have loaded every tenant's roles and granted their union.

**Every unique index starts with `tenantId` and is partial.** Unique on serial number alone
would collide across customers. Non-partial would allow exactly one null-serial asset per
tenant and would keep a deleted asset's serial locked forever.

---

## The flake that wasn't in the code

For three milestones a full-suite run failed intermittently — a different test each time,
usually in a `beforeEach` fixture, never reproducibly. Chasing it found three genuine
production bugs (the nested transaction retry, the upsert race, the transaction re-entrancy
trap above), each of which reduced the rate without ending it.

The actual cause was in the test harness: **supertest's `request(app)` starts a fresh HTTP
server and closes it for every call.** Across ~283 tests that is several thousand
listen/close cycles in two minutes, each leaving a socket in TIME_WAIT. On macOS the
ephemeral port range runs dry, and requests then fail as truncated responses, empty-bodied
404s, or calls that simply never return — symptoms that point everywhere except the real
problem.

`tests/helpers/testServer.ts` binds one server per file. Twenty consecutive full-suite runs
green, and the suite is no slower.

Two lessons worth keeping. Hypotheses that *reduce* a flake are not necessarily the cause —
each real bug found here made it rarer and hid the actual one. And a symptom that lands
somewhere different every time is usually a shared resource, not shared logic.

## Background jobs

`core/jobs` is one interface with two drivers:

| | BullMQ | Inline |
|---|---|---|
| When | Redis reachable | Redis absent (dev), or under test |
| Durability | Survives a restart | Lost on exit |
| Retries | Exponential backoff, then dead-letter | None |
| Deduplication by job id | Yes, across restarts | No |
| Distribution | Shared across replicas | This process only |

**The fallback is never silent in production.** Running jobs in-process on every API
replica would mean each scheduled scan firing N times with no durability, so an unreachable
Redis in production is a fatal boot error rather than a degraded mode.

**Only the worker registers handlers.** `main.ts` initialises the queue as a producer and
stops there. If the API also consumed, every replica would be a worker.

Verified against a real Redis: retries backing off across attempts, deduplication by job id
holding across a process restart, and the production boot refusing to start without it. The
committed tests use the inline driver, because a job that runs on shared infrastructure at an
unpredictable moment cannot be asserted on — and a suite that needs external services is one
people stop running.

Queues: `outbox` (drains events a request could not flush), `scheduled` (rollups, warranty
notices, storage sweeps), with `imports` and `exports` landing in M5.

## Testing

```
tests/
  globalSetup.ts               One in-memory replica set for the whole run
  setup.ts                     Per-file connection + truncation
  helpers/tenantFixtures.ts    Two-tenant fixture, context helpers
  helpers/isolationHarness.ts  Reusable cross-tenant assertions
  core/                        Plugin behaviour
  http/                        Real middleware chain via supertest
```

Two suites are **generated from the route table** (`tests/helpers/routeTable.ts`), which walks
the Express router stack:

- `tests/security/routeGuards.test.ts` — every route must declare `requirePermission(...)`,
  `requireAuth()` or `markPublic()`. Being public has to be a decision, not an omission.
- `tests/security/tenantIsolation.test.ts` — tenant A's credentials are driven against tenant
  B's records on every tenant-scoped route.

A new endpoint is covered the moment it is registered — the guard suite grew from 23 to 54
tests and the isolation suite from 14 to 38 purely by mounting the Milestone 2 routes.

The harness distinguishes a record id (`:id`, `:somethingId`) from a value parameter
(`:from` on `/lifecycle/transitions/:from`). Substituting a foreign record id into a value
parameter proves nothing, so those routes get the leakage check instead of the IDOR check —
they are never simply skipped.

`vitest.config.ts` sets `isolate: false` deliberately — with per-file module graphs, the
tenant plugin registers once per file against a different AsyncLocalStorage each time, while
`mongoose` stays shared. Isolation between tests comes from truncation in `afterEach`.

The isolation suite is the highest-value thing in this repository. From M1 it is **generated
from the route table**, so a new endpoint without an isolation test fails CI. A hand-maintained
version is one forgotten PR away from being a false sense of security.
