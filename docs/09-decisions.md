# Decision Log (ADRs)

Each entry: the decision, what was rejected, and the cost of being wrong.

---

### ADR-001 — MongoDB (as specified), with PostgreSQL as the standing recommendation
**Decision.** Build on MongoDB Atlas per the brief. Record that PostgreSQL is the better technical fit.
**Rejected.** Postgres + JSONB — better here on every axis except team familiarity: real foreign keys, partial unique indexes without caveats, window functions for reporting, GIN-indexed JSONB for custom fields, and Row-Level Security that makes cross-tenant leakage a *database* error rather than a code-review miss.
**Why Mongo is still workable.** Mongo 7+/Atlas gives multi-document transactions, compound wildcard indexes, partial unique indexes, Atlas Search and change streams — enough to build all of this correctly.
**Cost of being wrong.** ~15–20% more backend code for integrity checks, cascade jobs and aggregation pipelines. Mitigated by the repository layer, which keeps a future migration a data-layer project rather than a rewrite. Compensating decisions are marked `[mongo-mitigation]` throughout.
**Status.** **Decided 30 Aug 2026: MongoDB.** The team already operates Mongo/Atlas, and a stack the team can run beats a theoretically better one they cannot. The Postgres case above is recorded so the trade-off is a known cost rather than an oversight, and `[mongo-mitigation]` tags mark what would be deleted if we ever revisit.

### ADR-002 — Shared database with automatic `tenantId` scoping
**Decision.** Shared collections, `tenantId` on every document, enforced by ambient context + a plugin that **throws** when scope is absent, plus per-route isolation tests.
**Rejected.** Database-per-tenant (migrations × 10,000 tenants is what kills teams) · collection-per-tenant (index management explodes) · application-level filtering by convention (one forgotten `where` clause is a breach).
**Cost of being wrong.** A leak is existential. Hence five independent layers, the loudest of which is a CI-enforced test per route.

### ADR-003 — User ≠ Membership ≠ Person
**Decision.** Three entities: global login identity, tenant-scoped role holder, asset holder.
**Rejected.** A single `User` collection with `tenantId`. Simpler for a week, then permanently blocks multi-org users, contractors who hold assets without a login, and honest seat-based billing.
**Cost of being wrong.** Very high — retrofitting means rewriting auth, billing and every assignment reference. Cheap to do now, near-impossible later.

### ADR-004 — Type-bucketed custom fields (`cf.{s,n,d,b,r,m}`)
**Decision.** Embedded, type-partitioned document + a definition registry, with a compound wildcard index.
**Rejected.** EAV (unfilterable at scale) · untyped map (`"16" < "9"` — range queries and sorting silently wrong) · schema migration per field (defeats the purpose).
**Cost of being wrong.** Moderate — a migration job could re-bucket values, but every filter, sort and report would need rewriting. Immutable `key`s and stable option ids are what make renames safe.

### ADR-005 — Partial unique index enforces single active assignment
**Decision.** `{tenantId, assetId}` unique where `status='active'`. The database prevents double-assignment.
**Rejected.** Application-level checks (read-then-write race) · pessimistic locks (complexity, deadlocks) · a boolean on the asset (two sources of truth that will disagree).
**Cost of being wrong.** Data corruption that is expensive to detect and worse to explain to a customer. This is the highest-leverage line in the schema.

### ADR-006 — Three orthogonal state axes
**Decision.** `lifecycleState`, `currentAssignment` (derived), `condition` — separate fields.
**Rejected.** One `status` enum, as the brief implies. It creates unrepresentable-but-real states ("assigned *and* damaged?") and forces lossy status changes.
**Cost of being wrong.** High — unwinding a conflated status field corrupts historical records irreversibly.

### ADR-007 — Transactional outbox as the single event spine
**Decision.** Services write an outbox event inside the same transaction as the state change; audit, timeline, notifications, webhooks, search and metrics are subscribers.
**Rejected.** Direct calls from each service (adding webhooks means editing 25 services) · Mongo change streams as the primary source (fragile ordering, no replay, harder to test) · a message broker in v1 (operationally premature).
**Cost of being wrong.** Low — subscribers can be added or removed freely. High value: every future cross-cutting feature is a new subscriber.

### ADR-008 — Modular monolith, not microservices
**Decision.** One deployable, hard module boundaries enforced by lint and CI.
**Rejected.** Microservices — nothing here needs independent scaling, and distributed transactions across asset+assignment would be a self-inflicted wound.
**Cost of being wrong.** Low, *provided* boundaries are enforced from day one. A module with a clean public surface extracts in days. A monolith with tangled imports never extracts at all — which is why ADR-008 depends on the lint rules shipping in Milestone 0.

### ADR-009 — Async job queue from day one
**Decision.** BullMQ/Redis; imports, exports, reports, notifications, integrations and rollups are all jobs. API and worker share one codebase, two entrypoints.
**Rejected.** Synchronous processing "until it becomes a problem" — it becomes a problem at the first customer with a real spreadsheet, and by then the code assumes a request context.
**Cost of being wrong.** Low upfront cost, avoids a certain future rewrite.

### ADR-010 — Cursor pagination by default
**Decision.** Cursor over `{tenantId, createdAt, _id}` for all large collections; offset capped at page 100 for small admin tables.
**Rejected.** Offset everywhere — Mongo walks every skipped document, and results shift under concurrent writes.
**Cost of being wrong.** Moderate — changing pagination style is an API breaking change, which is exactly why it is decided now.

### ADR-011 — Rollup tables for dashboards
**Decision.** `metricsDaily` rollups, incrementally updated from events; dashboards never aggregate the live collection.
**Rejected.** Live `$group` pipelines. Fine at 1,000 assets, the first thing to fall over at 100,000.
**Cost of being wrong.** Low — rollups can be rebuilt from events at any time.

### ADR-012 — Audit log and asset timeline are separate collections
**Decision.** Two collections, different consumers, different retention, different mutability, both fed by the outbox.
**Rejected.** One combined history. Compliance needs immutability and login/permission events; users need a readable asset story. Merging them makes both worse.
**Cost of being wrong.** Low.

### ADR-013 — References, not name copies, in history
**Decision.** Audit and timeline records store actor and subject **ids**; display names are resolved at read time and fall back to "Deleted user (ref …)".
**Rejected.** Denormalising names into history for cheap reads. It makes GDPR erasure impossible without destroying history — an unresolvable conflict discovered too late.
**Cost of being wrong.** Very high and only surfaces under a legal deadline. Costs one extra lookup at read time; worth it.

### ADR-014 — Archive, never delete, anything referenced
**Decision.** Categories, locations, departments, vendors, asset types and custom fields archive. Deletion is blocked while references exist. Purge is explicit, confirmed and audited.
**Rejected.** Cascade delete (destroys history) · orphaning references (breaks rendering).
**Cost of being wrong.** Moderate — orphan cleanup is tedious and user trust is hard to rebuild.

### ADR-015 — 404, not 403, for cross-tenant resources
**Decision.** A foreign resource is indistinguishable from a missing one. `403` is reserved for genuine in-tenant permission failures.
**Rejected.** Honest `403`s everywhere — they confirm existence and turn every endpoint into an enumeration oracle.
**Cost of being wrong.** Low, and it is a one-line policy in the error middleware.

### ADR-016 — REST, not GraphQL
**Decision.** REST with uniform conventions, OpenAPI generated from Zod schemas.
**Rejected.** GraphQL — the flexibility mostly benefits third-party consumers we don't have yet, and it makes per-field authorization, rate limiting, caching and query-cost control substantially harder in a multi-tenant product.
**Cost of being wrong.** Low — a GraphQL layer can be added over the same services later if a customer integration demands it.
