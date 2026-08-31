# Phase 2 — Architecture

## 1. System shape

```
                     ┌──────────────────────────────┐
   Browser (React) ──▶│   CDN / static hosting       │
                     └──────────────────────────────┘
                                  │ HTTPS (JSON REST)
                     ┌────────────▼─────────────────┐
                     │  API (Node + Express)        │   stateless, N replicas
                     │  ┌────────────────────────┐  │
                     │  │ HTTP layer             │  │  routes, validation, authn
                     │  ├────────────────────────┤  │
                     │  │ Module services        │  │  business logic, authz, txns
                     │  ├────────────────────────┤  │
                     │  │ Repository layer       │  │  tenant-scoped data access
                     │  └────────────────────────┘  │
                     └───┬─────────┬──────────┬─────┘
                         │         │          │
            ┌────────────▼──┐  ┌───▼────┐  ┌──▼──────────┐
            │ MongoDB Atlas │  │ Redis  │  │ S3 / R2     │
            │ replica set   │  │ cache, │  │ documents   │
            └───────────────┘  │ queues │  └─────────────┘
                               │ limits │
                               └───┬────┘
                     ┌─────────────▼────────────────┐
                     │  Worker (same codebase)      │   N replicas
                     │  imports, exports, emails,   │
                     │  rollups, webhooks, scans    │
                     └──────────────────────────────┘
```

**API and Worker are the same deployable, started with a different entrypoint.** Same modules, same services, same models — the worker just runs job processors instead of an HTTP listener. This keeps business logic in exactly one place and means a job and a request can never diverge in behaviour.

---

## 2. Backend: modular monolith

### 2.1 Layout

```
src/
  main.ts                     # API entrypoint
  worker.ts                   # Worker entrypoint
  config/                     # env schema (validated at boot), constants
  core/                       # framework, owned by nobody, used by everybody
    context/                  # AsyncLocalStorage request context  ◀── D1
    db/                       # connection, tenantScope plugin, softDelete plugin, txn helper
    http/                     # response envelope, error classes, async wrapper
    errors/                   # AppError taxonomy
    events/                   # EventBus + outbox writer/dispatcher      ◀── D5
    jobs/                     # queue definitions, worker registry
    auth/                     # token issue/verify, password hashing
    authz/                    # permission registry, requirePermission, scope resolver
    entitlements/             # plan limit checks
    validation/               # zod helpers, common schemas
    storage/                  # S3 adapter (presign, delete, copy)
    search/                   # SearchService interface + mongo impl
    audit/                    # audit writer (outbox subscriber)
    logging/                  # pino, request-id, redaction
    telemetry/                # metrics, tracing, health
  modules/
    identity/                 # User, session, password, invitation
    tenants/                  # Tenant, onboarding, settings
    memberships/              # user×tenant, roles assignment
    roles/                    # roles, permissions
    subscriptions/            # plans, subscription, usage
    people/                   # asset holders, departments, locations, cost centres
    catalog/                  # asset types, categories, custom field definitions, lifecycles
    assets/                   # the asset aggregate
    assignments/              # assign / return / transfer
    timeline/                 # asset events (user-facing history)
    maintenance/              # maintenance + repair records
    vendors/                  # vendors, contracts
    procurement/              # purchase orders, requests            (v1.2)
    software/                 # software products, licences, seats   (v1.1)
    documents/                # attachments
    notifications/            # dispatcher, channels, preferences
    imports/                  # import jobs, staging, validation, commit
    exports/                  # export jobs
    reports/                  # aggregations, rollups
    auditlog/                 # read API over audit records
    search/                   # cross-entity search endpoints
    settings/                 # tenant configuration
    integrations/             # webhooks, api keys, external syncs   (v1.2)
    platform/                 # super-admin surface
  shared/                     # cross-module value types, enums, utils (no business logic)
```

### 2.2 Module anatomy

Every module is the same shape. No exceptions — predictability is the point.

```
modules/assets/
  asset.model.ts          # mongoose schema + indexes
  asset.repository.ts     # ALL db access for this module
  asset.service.ts        # business logic, transactions, event emission
  asset.controller.ts     # http in/out only, zero logic
  asset.routes.ts         # route table + middleware chain
  asset.schema.ts         # zod request/response schemas
  asset.policy.ts         # authorization rules for this resource
  asset.events.ts         # event type definitions this module emits
  asset.mapper.ts         # domain → API DTO (controls what leaves the server)
  __tests__/
  index.ts                # public surface — the ONLY thing other modules may import
```

### 2.3 The rules that keep it modular

These are enforced by ESLint `no-restricted-imports` and a dependency-cruiser rule in CI, not by good intentions.

1. **A module may only import another module through its `index.ts`.** Reaching into `../assets/asset.model` is a build failure.
2. **A module never imports another module's model or repository.** Data crosses boundaries as DTOs.
3. **No circular module dependencies.** If assets need people and people need assets, one of them listens to an event instead.
4. **Controllers contain no logic.** Parse, call service, map response. If there is an `if` about business rules in a controller, it is in the wrong place.
5. **Repositories are the only code that touches Mongoose.** Services never build queries.
6. **Services never touch `req`/`res`.** They take typed arguments and the ambient request context.

When a module needs to be extracted into a service later, the seam is already cut: replace its `index.ts` with an HTTP client.

---

## 3. Multi-tenancy `[D1]`

### 3.1 Model

**Shared database, shared collections, `tenantId` discriminator.** The alternatives:

| Approach | Isolation | Cost | Ops burden | Verdict |
|---|---|---|---|---|
| DB per tenant | Strongest | High | Migrations × N tenants, connection sprawl | Enterprise tier only, later |
| Collection per tenant | Medium | High | Index management explodes | No |
| **Shared + `tenantId`** | Good, if enforced | Low | One schema, one migration | **Yes** |

At 10,000 tenants, DB-per-tenant means 10,000 migration runs per release. That is the thing that actually kills teams.

### 3.2 Enforcement — the important part

The failure mode is not "we chose the wrong model", it is "someone wrote one query without `tenantId`". So the design makes that impossible rather than discouraged.

**Layer 1 — Ambient context.** An `AsyncLocalStorage` store is populated by middleware after authentication and carries `{ requestId, tenantId, userId, membershipId, permissions, scope }` through every async call, including into services and repositories, with no parameter threading.

**Layer 2 — Mandatory Mongoose plugin.** Applied globally at connection setup:

- Adds `tenantId` to every schema, `required`, `index`.
- `pre` hooks on `find`, `findOne`, `findOneAndUpdate`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `count*`, `distinct`, and `aggregate` inject `tenantId` from the context.
- `pre('save')` stamps `tenantId` on new documents from context, and **throws if the document's `tenantId` differs from the context** — this catches cross-tenant writes.
- **If the context has no `tenantId`, the query throws.** Not "returns everything" — throws. A missing context is a bug, and it fails loudly in development and in tests rather than silently leaking in production.
- Models explicitly marked `{ tenantScope: 'global' }` (Plan, Tenant, User, platform AuditLog) are exempt. That list is short, reviewed, and asserted in a test.

**Layer 3 — Explicit escape hatch.** Cross-tenant reads (platform analytics, super-admin tooling) go through `withoutTenantScope(reason, fn)`, which is greppable, requires a reason string, and writes a platform audit record. Any use outside `modules/platform/` fails lint.

**Layer 4 — IDs are never trusted.** `tenantId` is never read from a request body, query string, path parameter, or header. It comes from the authenticated session only. A request for `/assets/:id` belonging to another tenant returns **404, not 403** — a 403 confirms the resource exists.

**Layer 5 — Automated isolation tests.** A test suite creates two tenants with parallel fixtures and, for **every registered route**, asserts that tenant A's credentials cannot read, update, or delete tenant B's resources. New routes are added to the registry automatically; a route without an isolation test fails CI. This is the single highest-value test suite in the project.

### 3.3 Future: dedicated infrastructure

All connection acquisition goes through `getConnection(tenantId)`. Today it returns the one shared connection. Later it can consult a tenant→cluster routing table for an enterprise tenant or an EU-residency tenant. No call site changes.

---

## 4. Authentication

### 4.1 Tokens

| Token | Lifetime | Storage | Contents |
|---|---|---|---|
| Access | 15 min | Memory (SPA) / `httpOnly` cookie | `sub`, `tenantId`, `membershipId`, `permVersion`, `jti` |
| Refresh | 30 days, sliding | `httpOnly`, `Secure`, `SameSite=Lax` cookie, path-scoped | opaque, hashed at rest |

**Refresh rotation with reuse detection.** Each refresh issues a new token and invalidates the old one, within a token *family*. If a token that has already been rotated is presented again, the entire family is revoked and a security event is raised — this is how a stolen refresh token gets caught.

**Claims are a cache, not authority.** `permVersion` in the access token is compared against the membership's current version; a mismatch forces a refresh. Permission changes therefore take effect within one access-token lifetime at worst, immediately on the next refresh. Destructive actions (delete, billing, role change) re-read permissions from the database rather than trusting the token.

**Revocation.** A `tokenVersion` on the user and a `permVersion` on the membership give us instant logout-everywhere and instant permission revocation without a token blocklist.

### 4.2 Tenant selection

A user may belong to several tenants `[D2]`. Login authenticates the *user*; a second step selects the *membership* and mints a tenant-scoped access token. Switching tenants is a token exchange, not a re-login. The URL carries the tenant slug (`/o/acme/assets`) for bookmarkability, but the slug is **validated against the token**, never used to select the tenant.

### 4.3 Roadmap
MFA (TOTP) v1.2 · SAML/OIDC SSO and SCIM provisioning v2, with per-tenant enforcement ("SSO required") and a break-glass owner account.

---

## 5. Authorization `[D2]`

### 5.1 Structure

```
Permission   "asset:update"           declared once in a central registry
Role         { name, permissions[], isSystem, scopeType }
Membership   { userId, tenantId, roleIds[], scopeIds[], permVersion }
```

Effective permissions are the union of the membership's roles, computed once per request and cached in Redis keyed by `membershipId:permVersion` — so a role change invalidates automatically by changing the key.

### 5.2 Two-level check

**Level 1 — can they do this kind of thing?** Route middleware: `requirePermission('asset:update')`. Cheap, declarative, covers 90% of cases.

**Level 2 — can they do it to *this* record?** Service-level policy: `assetPolicy.canUpdate(actor, asset)`. This is where scoping lives — a Manager scoped to the London office cannot edit a Manchester asset even though they hold `asset:update`.

**Scoped list queries** are handled in the repository: the scope resolver contributes an additional filter (`locationId: { $in: [...] }`) to list queries, so a scoped user's list and their detail access can never disagree.

### 5.3 Non-negotiable invariants

- No permission string is ever compared inline in a controller — everything goes through the registry, so the full permission surface is enumerable and testable.
- **Privilege escalation guard:** granting a role requires holding every permission that role grants. Enforced in `roles.service`, tested explicitly.
- **Last-owner guard:** the final `Owner` of a tenant cannot be removed, demoted, or deactivated. Ownership must be transferred first.
- The frontend hides UI based on permissions **as a convenience only**. Every check exists server-side. The client's permission list is derived from the same registry so they cannot drift.

---

## 6. Dynamic custom fields `[D3]`

### 6.1 Why not the obvious approaches

| Approach | Fails because |
|---|---|
| EAV (`{assetId, key, value}` rows) | Filtering on 3 fields = 3 joins/lookups. Sorting is impossible at scale. |
| `Map<string, any>` on the asset | No type safety, no range queries (`"16"` sorts before `"9"`), can't index meaningfully |
| Column-per-field via migration | Defeats the entire purpose |

### 6.2 The design: type-bucketed embedded document

```js
// on the asset document
cf: {
  s: { chip: "M3 Pro", os_build: "14.4.1" },      // string, select (stores option id)
  n: { ram_gb: 36, battery_health: 92 },           // number, currency (minor units)
  d: { applecare_expiry: ISODate("2027-03-14") },  // date
  b: { is_encrypted: true },                       // boolean
  r: { insurer: ObjectId("...") },                 // reference (user/asset/vendor)
  m: { tags: ["design", "loaner"] }                // multi-select (array of option ids)
}
```

Types are separated so that **`n` compares as numbers and `d` compares as dates** — range filters, sorting, and aggregation all work correctly. This is the whole trick, and it is why an untyped blob is the wrong answer.

Indexed with a compound wildcard index `{ tenantId: 1, "cf.$**": 1 }` (MongoDB 7.0+), so any custom field is filterable without knowing its name at schema time. `[mongo-mitigation — Postgres JSONB+GIN does this natively]`

### 6.3 The registry

`CustomFieldDefinition` is tenant-scoped and describes each field:

```
key            immutable slug, generated from label, unique per (tenant, appliesTo)
label          user-facing, freely renameable
type           text | textarea | number | currency | date | boolean | select
               | multiselect | url | email | reference | file
bucket         derived from type — s | n | d | b | r | m
appliesTo      entity: asset | person | vendor | licence  (+ optional assetTypeIds[])
options[]      for select/multiselect: { id, label, colour, archived }
validation     { required, min, max, regex, precision, unique }
display        { section, order, helpText, showInTable, showInCard }
flags          { isPii, isSearchable, isReadOnlyFromIntegration }
status         active | archived
```

**`key` is immutable and `options[].id` is stable.** Renaming a field or a dropdown option is a label change, so no stored data breaks. This one decision prevents an entire category of data corruption.

### 6.4 Field lifecycle

- **Create** — validated against the plan's custom-field limit; a background job may backfill a default.
- **Rename** — label only; `key` never changes.
- **Type change** — **not permitted.** The correct action is archive + create new, optionally with a migration job that previews the conversion and reports rows it cannot convert. Silent coercion loses data.
- **Archive** — hidden from forms, tables and filters; **values remain on documents**. Reversible. This is the answer to "custom field removed while assets use it".
- **Purge** — a separate, explicit, confirmed, audited background `$unset` across the tenant's documents. Only an Owner can do it, and only on an archived field.

### 6.5 Validation

Field definitions compile to a Zod schema, cached per `(tenantId, assetTypeId, definitionsVersion)`. Asset writes validate against it. The same compiled definitions drive the React form renderer, the import validator, and the filter builder — one source of truth, three consumers.

---

## 7. Asset lifecycle `[D6]`

### 7.1 Three orthogonal axes — this matters

The brief lists "In stock", "Assigned", "Damaged" and "Retired" as one status list. They are three different things, and merging them creates unanswerable states ("assigned *and* damaged?").

| Axis | Field | Values | Who changes it |
|---|---|---|---|
| **Lifecycle** | `lifecycleState` | procured → received → in_stock → deployed → in_maintenance → pending_return → retired → disposed / lost | Lifecycle engine, via transitions |
| **Assignment** | `currentAssignment` | derived — a cached pointer to the active Assignment, or null | **Only** the assignment service |
| **Condition** | `condition` | new / good / fair / poor / damaged / unknown | Any editor, recorded on check-in |

`currentAssignment` is a denormalised cache written exclusively by the assignment service inside the same transaction that writes the Assignment record. Nothing else may write it. A nightly reconciliation job asserts it matches the Assignment collection and alerts on drift.

### 7.2 Configurable state machine

Stored per tenant, optionally per asset type:

```js
LifecycleWorkflow {
  states: [{ key, label, colour, isTerminal, category }],
  transitions: [{
    from, to, label,
    requiredPermission,       // "asset:retire"
    requiredFields[],         // must be filled to make this transition
    guards[],                 // e.g. "no_active_assignment"
    effects[],                // e.g. "unassign", "notify_manager"
    requiresComment
  }],
  initialState
}
```

The engine validates every transition: is it declared, does the actor hold the permission, do the guards pass, are required fields present. An undeclared transition is rejected — you cannot go from `disposed` back to `in_stock` unless the tenant declared that path.

A sensible default workflow is seeded on tenant creation so nobody has to configure anything to start.

### 7.3 Assignment invariants `[D4]`

The single most important constraint in the system:

```js
// assetAssignments
{ assetId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } }
```

**The database refuses a second active assignment for an asset.** Two admins clicking "assign" simultaneously: one succeeds, one gets a duplicate-key error which the service translates into `409 ASSET_ALREADY_ASSIGNED` with the current holder. No application-level lock, no read-then-write race, no reconciliation script.

Assign, return and transfer all run inside a MongoDB multi-document transaction covering the Assignment record, the asset's cached pointer, and the outbox event — so history can never disagree with state.

Assignees are polymorphic (`assigneeType`: `person` | `location` | `asset`), which covers a laptop held by a person, a monitor allocated to a meeting room, and a docking station attached to a laptop — without three separate mechanisms.

---

## 8. Events, audit and the outbox `[D5]`

### 8.1 Why an outbox

Every cross-cutting concern — audit log, asset timeline, notifications, webhooks, search indexing, metric rollups — needs to know when something happened. Without a central mechanism, adding webhooks in v1.2 means editing all 25 services.

### 8.2 Flow

```
service.assignAsset()
  └─ transaction {
       write Assignment
       update Asset.currentAssignment
       insert OutboxEvent { type: 'asset.assigned', payload, tenantId, actorId }
     }                          ▲ same transaction — event and state cannot diverge
  └─ commit
        │
   dispatcher (polls outbox, or change stream)
        ├──▶ AuditWriter        → auditLogs (immutable)
        ├──▶ TimelineProjector  → assetEvents (user-facing feed)
        ├──▶ NotificationRouter → in-app + email, per preferences
        ├──▶ WebhookDispatcher  → tenant endpoints, signed, retried  (v1.2)
        ├──▶ SearchIndexer      → Atlas Search                        (v1.1)
        └──▶ MetricsRollup      → daily counters for the dashboard
```

Subscribers are idempotent and keyed by `eventId`, so redelivery is safe. Failures retry with backoff and land in a dead-letter queue with an alert — a failed webhook must never fail the user's request.

### 8.3 Audit log vs. asset timeline — two different things

The brief treats these as one. They have different consumers and different rules.

| | Audit log | Asset timeline |
|---|---|---|
| Consumer | Compliance, security, us | End users |
| Content | Every sensitive action incl. logins, permission changes, exports, config | Asset-relevant business events |
| Mutability | Append-only. No update or delete route exists. Optional hash chain (`prevHash`) for tamper evidence on Enterprise. | Append-only, but rebuildable from the outbox |
| Retention | Per plan, via TTL on a per-document `expiresAt` set at write time from the tenant's plan `[mongo-mitigation for per-tenant TTL]` | Same as the asset |
| PII | Stores actor **references**, never name/email copies — so GDPR erasure tombstones the person and the audit trail still renders "Deleted user (ref 7f3a)" | Same |
| Access | `audit:read` permission; not editable by any tenant role including Owner | Anyone who can view the asset |

---

## 9. File storage

**S3-compatible object storage (Atlas is our DB, not our file system).** Never store files in MongoDB — GridFS is a last resort for environments without object storage, and we don't have that constraint.

Upload flow: client requests a presigned PUT → server validates declared type/size against plan storage entitlement and creates a `pending` Document record → client uploads directly to S3 → client confirms → server **verifies the object exists, checks its real size, and reads its magic bytes to confirm the actual content type**, then marks it `ready`.

Validating only the client-declared MIME type is the standard mistake. A sweeper job deletes `pending` records older than 24 hours and their orphaned objects.

Download is always a short-lived presigned GET (5 min) issued after an authorization check. **The bucket is never public.** Keys are `t/{tenantId}/{entityType}/{entityId}/{uuid}{ext}` — the tenant prefix means a bucket policy can enforce isolation as a second line of defence, and it makes tenant export/deletion a prefix operation.

Additional controls: extension + magic-byte allowlist, SVG rejected (or served `Content-Disposition: attachment` with a sandboxing CSP), EXIF stripped from images, ClamAV scan job on Business+ before a file becomes downloadable, per-tenant storage counter updated transactionally.

---

## 10. Background jobs `[D7]`

**BullMQ on Redis**, from day one. Queues:

| Queue | Jobs | Notes |
|---|---|---|
| `imports` | parse, validate, commit | **Concurrency 1 per tenant** — concurrent imports of the same file are the classic duplicate-creation bug |
| `exports` | build file, presign, notify | |
| `notifications` | send email, dispatch in-app | Rate-limited per provider |
| `outbox` | dispatch events to subscribers | The busiest queue |
| `scheduled` | warranty scan, licence expiry, maintenance due, usage recount, rollups | Cron-triggered, tenant-batched |
| `maintenance` | orphan sweep, assignment reconciliation, purge jobs, retention | Off-peak |

Every job is **idempotent and keyed** — retries and duplicate deliveries must be safe. Jobs run under a synthetic tenant context so the isolation plugin applies to them exactly as it does to requests.

Scheduled scans iterate tenants in batches rather than scanning all assets globally, so one enormous tenant cannot starve the rest.

---

## 11. Search and reporting

### 11.1 Search — behind an interface from day one

`SearchService` is an interface with three implementations over time:

1. **v1** — MongoDB. A normalised `searchTokens` array on the asset (name, tag, serial, model, brand, assignee name, all lowercased and de-punctuated) with a multikey index. Prefix matching covers "type a few characters of the serial", which is the actual behaviour users want.
2. **v1.1** — **Atlas Search** (Lucene). Fuzzy matching, relevance ranking, faceting, cross-entity search. Queries always carry a `tenantId` filter clause. Since we're already on Atlas, this is the natural upgrade.
3. **Later** — self-hosted OpenSearch if we ever leave Atlas.

Call sites never change. `$text` indexes are deliberately skipped — one per collection, poor relevance, and no facets.

### 11.2 Dashboards must not aggregate the live collection

At 100k assets per tenant, running six `$group` pipelines on every dashboard load will be the first thing that falls over.

- **`MetricsDaily`** rollup documents per tenant per day, written by the rollup job and incrementally nudged by outbox events.
- Dashboard reads rollups, not assets. Response target < 150 ms.
- Redis cache with tenant-scoped keys, invalidated by event type.
- **Heavy/ad-hoc reports run as async jobs** and deliver a downloadable file. No report ever blocks an HTTP request for more than a couple of seconds.
- Reporting aggregations use a `secondaryPreferred` read preference so analytics cannot slow down transactional writes.

---

## 12. Frontend architecture

**React 18 + TypeScript + Vite + Tailwind + TanStack Query + React Router + React Hook Form + Zod.**

```
src/
  app/            router, providers, error boundaries, layout shells
  lib/            api client, auth, permissions, formatting, i18n
  components/ui/  design-system primitives (Button, Table, Drawer, ...)
  components/     composed shared components (DataTable, FilterBar, FieldRenderer)
  features/       mirrors backend modules: assets/, people/, assignments/, ...
    assets/
      api/        typed hooks over the API client
      components/
      pages/
      schema.ts   zod schemas SHARED with the backend contract
  types/          generated from the API contract
```

Key positions:

- **TanStack Query is the state layer.** No Redux. Server state is server state; the small amount of genuinely global client state (auth, tenant, UI prefs) lives in Context.
- **`features/` mirrors backend modules exactly.** One mental model across the stack.
- **The dynamic form renderer is a first-class component.** `<FieldRenderer definition={def} />` renders any custom field type; asset forms are generated from `CustomFieldDefinition[]`, never hand-written per type. Same for the filter builder and the table column picker.
- **`DataTable` is built once** with server-side pagination, sorting, filtering, column visibility, row selection and bulk actions, and is reused by every list screen. Getting this component right is worth a week.
- **The client never receives more than a page of data.** Filtering and sorting are always server-side.
- **Permission-aware rendering** via a `<Can permission="asset:delete">` component reading the same permission registry as the backend — convenience only, never the security boundary.
- **Route-level code splitting** per feature, so the initial bundle stays small.

---

## 13. Observability & operations

- **Structured JSON logs** (pino) with `requestId`, `tenantId`, `userId`, `route`, `durationMs` on every line. Automatic redaction of tokens, passwords, and fields flagged `isPii`. `tenantId` on every log line is what makes customer-specific debugging possible at all.
- **Error tracking** (Sentry) with tenant and user tags and release versioning.
- **Metrics**: request rate/latency/error by route, queue depth and job duration by queue, DB pool utilisation, slow-query log, per-tenant API usage.
- **Tracing**: OpenTelemetry, propagated from request through service, repository and into jobs.
- **Health endpoints**: `/health/live` (process up) and `/health/ready` (Mongo + Redis + S3 reachable) for the load balancer.
- **Config**: env vars validated by a Zod schema **at boot** — the process refuses to start with a missing or malformed variable, rather than failing at 3am on the first request that needs it. Secrets from a secret manager in production; `.env` is development-only and never in an image.
