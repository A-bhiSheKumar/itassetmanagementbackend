# IT Asset Management SaaS — Architecture Overview

**Status:** Milestone 0 complete — foundations built, no business features yet
**Owner:** akumar@gbtechservice.com
**Last updated:** 2026-08-30

---

## 1. What we are building

A multi-tenant SaaS platform where an organisation can answer, at any moment:

> *What do we own, where is it, who has it, what condition is it in, what did it cost, when does its warranty/licence expire, what has been done to it, and what is its complete history?*

The product is **not** a CRUD app over a `assets` table. Three things make it defensible:

1. **A dynamic asset model** — tenants define their own asset types, fields, statuses and lifecycles without a schema migration or redeploy.
2. **A trustworthy history** — every state change is an immutable event, so the system is an audit record, not just a database.
3. **Correctness under concurrency** — an asset cannot be assigned to two people, a tag cannot be duplicated, an import cannot half-apply. These are enforced at the storage layer, not in application `if` statements.

Everything else (dashboards, imports, reports, notifications) is table stakes that competitors also have.

---

## 2. The seven decisions that matter

Everything downstream follows from these. They are the ones that are expensive to change later.

| # | Decision | Choice | Why it is hard to reverse |
|---|---|---|---|
| D1 | Tenant isolation | Shared DB, `tenantId` on every document, **enforced automatically** by an AsyncLocalStorage request context + a mandatory Mongoose plugin that refuses un-scoped queries | Retrofitting this means auditing every query in the codebase |
| D2 | Identity model | `User` (global login) ≠ `Membership` (user×tenant) ≠ `Person` (asset holder, may never log in) | Collapsing these makes multi-org users, contractors, and seat-based billing impossible to add later |
| D3 | Custom fields | Type-bucketed embedded document `cf.{s,n,d,b,r}` + `CustomFieldDefinition` registry, indexed by compound wildcard index | EAV or untyped blobs make filtering/sorting/reporting on custom fields impossible at scale |
| D4 | Assignment | Its own collection with a **partial unique index** on `(assetId)` where `status='active'` | The DB, not the app, is what prevents double-assignment. Bolting this on later means reconciling dirty data |
| D5 | Change capture | Domain services emit events to a transactional **outbox**; audit log, asset timeline, notifications, webhooks and search indexing are all subscribers | Without it, every new cross-cutting feature means editing every service again |
| D6 | Three orthogonal state axes | `lifecycleState` (procured→disposed), `assignmentState` (derived from Assignment), `condition` (physical) — never one `status` field | Conflating them is the #1 modelling mistake in ITAM; unwinding it later corrupts history |
| D7 | Async by default | Imports, exports, reports, notifications, integrations all run on a job queue (BullMQ/Redis) from day one | A synchronous 10k-row Excel import in an Express handler is the failure every ITAM tool hits at ~customer #20 |

Full rationale and rejected alternatives: [09-decisions.md](09-decisions.md).

---

## 3. One recommendation that contradicts the brief

**The brief specifies MongoDB. I would choose PostgreSQL, and I want that on the record before we build.**

This workload is relational and transactional, not document-shaped:

- **Referential integrity everywhere.** Assets→categories→locations→people→departments→vendors→licences. Mongo gives us none of it; we hand-roll every check and every orphan-cleanup job.
- **Uniqueness rules are conditional.** "Serial number unique per tenant, *when present*, *among non-deleted rows*." Postgres partial unique indexes express this natively; Mongo partial indexes can do it but with sharper edges.
- **Reporting is the product.** Depreciation, spend by cost centre, licence utilisation, warranty pipelines — these are joins and window functions. `$lookup` pipelines get slow and unreadable fast.
- **Custom fields are *better* in Postgres.** `JSONB` + GIN indexes gives us the same dynamism with real typed queries, constraints, and no wildcard-index caveats.
- **Tenant isolation can be enforced by the database.** Postgres Row-Level Security makes a cross-tenant leak a database error, not a code-review miss. This is a genuinely stronger guarantee than any application-layer plugin.

**Cost of choosing Mongo anyway:** roughly 15–20% more backend code (integrity checks, cascade jobs, aggregation pipelines instead of SQL), and tenant isolation resting on discipline plus one plugin rather than on the database.

**This is a real but survivable cost.** MongoDB 7+/Atlas gives us multi-document ACID transactions, compound wildcard indexes, partial unique indexes, Atlas Search, and change streams — enough to build all of this properly.

**Recommendation:** if the team's existing operational experience is Mongo/Atlas, stay on Mongo — a stack the team can operate beats a theoretically better one they cannot. If the choice is genuinely open, pick Postgres.

**Everything in these documents is designed against MongoDB**, as specified. Where a decision exists purely to compensate for Mongo, it is marked `[mongo-mitigation]` so it can be simplified if we ever switch. The module boundaries and repository layer are drawn so a migration would be a data-layer project, not a rewrite.

**Decided 30 Aug 2026: MongoDB**, on team-familiarity grounds. See ADR-001.

---

## 4. What was missing from the brief

The brief is unusually thorough. These are the material gaps — the first four are the ones I would not ship v1 without accounting for, even if they aren't built yet.

### Must be designed for now (even if built later)

| Gap | Why it matters now |
|---|---|
| **Consumables & stock** (toner, cables, adapters) | Quantity-based, non-serialised, no individual identity. A fundamentally different model from serialised assets. Every real customer asks for it. If assets and stock share one collection by accident, this becomes a rewrite. |
| **Directory sync (SSO / SCIM / HRIS)** | The entire joiner-mover-leaver flow the brief describes under "Employee Management" is, in every real deployment, driven by Entra ID / Okta / Google Workspace / an HRIS — not by hand. `Person` must be designed with `externalRefs[]` and a sync-source field from day one. |
| **Discovery / MDM integration** | The brief asks for CPU, RAM, encryption status, antivirus status, last check-in. Those fields are only trustworthy if an agent or MDM (Intune, Jamf, Kandji) writes them. That requires field-level provenance — which fields are authoritative from the integration vs. human-editable — or sync will silently overwrite people's work. |
| **Depreciation & book value** | The brief asks for "asset value" but never says which value. Purchase price, current book value, and salvage value are three different numbers, and finance teams need all three. Needs `depreciationMethod`, `usefulLifeMonths`, `salvageValue` on the asset from the start. |

### Should be on the roadmap

- **Asset requests & approvals** — mentioned once under "Member" but it is a whole workflow (request → approve → fulfil → assign).
- **Check-out/check-in for shared pool assets** (projectors, loaner laptops, tools) — distinct from long-term assignment; has due dates and overdue states.
- **Stocktake / audit sessions** — scan a location, reconcile expected vs. found, produce a variance report. This is what auditors actually ask for.
- **Kits & parent/child assets** — a laptop with a dock and two monitors; RAM installed in a server. Needs `parentAssetId` + component semantics.
- **Contracts as a first-class entity** — support contracts, leases, and SaaS agreements are referenced by both vendors and licences.
- **Webhooks, API keys, and a public API** — listed as a plan feature but never designed. Cheap now, expensive later.
- **Bulk operations** — bulk edit / bulk assign / bulk retire. Users with 5,000 assets will not click 5,000 times.
- **Scheduled reports** — "email me the warranty expiry report every Monday."
- **Support impersonation** — Super Admin "view as tenant", time-boxed, reason-required, fully audited, and blockable per tenant.
- **Warranty auto-lookup by serial** (Dell/Lenovo/Apple APIs) — small feature, disproportionate demo impact.

### Compliance items with no home in the brief

- **GDPR erasure vs. immutable audit.** These directly conflict. Resolution: audit records store an **actor reference**, not a name/email copy; erasure tombstones the `Person` and `User` records and the audit trail renders "Deleted user (ref 7f3a)". History survives, PII does not. This must be designed now — it cannot be retrofitted onto denormalised name copies.
- **Data residency** — EU tenants may require EU-hosted data. The tenant→connection resolver (see [02-architecture.md](02-architecture.md)) makes this a routing change rather than a rewrite.
- **Tenant offboarding** — full data export + verifiable deletion, on a clock.
- **Multi-currency** — store minor units + ISO code + FX rate captured at purchase date. Never floats, never a single implied currency.
- **Time zones** — "warranty expires today" is tenant-local. All storage UTC, all boundaries computed in tenant tz.

---

## 5. Where to go next

| Document | Contains |
|---|---|
| [01-product-scope.md](01-product-scope.md) | Personas, workflows, feature prioritisation, MVP cut line |
| [02-architecture.md](02-architecture.md) | Modular monolith, multi-tenancy, auth, permissions, files, jobs, events |
| [03-data-model.md](03-data-model.md) | Every collection, key fields, and **every index with its rationale** |
| [04-api-design.md](04-api-design.md) | Conventions, endpoint map, errors, pagination, filtering |
| [05-ui-ux.md](05-ui-ux.md) | Layout, navigation, screens, states, responsive behaviour |
| [06-edge-cases.md](06-edge-cases.md) | Specified behaviour for every edge case, including ones not in the brief |
| [07-security.md](07-security.md) | Threat model and controls |
| [08-roadmap.md](08-roadmap.md) | Phased delivery plan, testing strategy, production readiness gate |
| [09-decisions.md](09-decisions.md) | ADR log — decisions, alternatives considered, and why they were rejected |

---

## 6. Open questions for you

These change the design and I cannot answer them from the brief.

1. ~~MongoDB or PostgreSQL?~~ **Answered: MongoDB.**
2. **Who is the first customer profile** — 50-person startup, 500-person mid-market, or 5,000-person enterprise? This decides whether SSO/SCIM is v1 or v2, and whether the UI optimises for simplicity or for power users with saved views and bulk edit.
3. **Is a mobile scanning app in scope for year one?** If yes, the API needs to be designed for it now (offline queueing, idempotent writes). If no, a responsive PWA covers scanning adequately.
4. **Do we need consumables/stock in v1**, or can v1 be serialised assets only? This is the single biggest scope lever.
5. **Payment provider** — Stripe, or manual/offline invoicing for the first cohort? (Recommendation: manual for the first ~20 customers; the billing abstraction means Stripe is a two-week add later.)
6. **Compliance targets** — is SOC 2 or ISO 27001 on the horizon? If yes, audit retention, access reviews, and encryption-at-rest decisions change now rather than later.
