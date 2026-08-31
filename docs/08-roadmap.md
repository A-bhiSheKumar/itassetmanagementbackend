# Development Roadmap

Estimates assume **2–3 full-stack engineers**. Scale accordingly. Every milestone ends with something demonstrable — no phase exists only to produce internal plumbing that cannot be shown.

---

## Milestone 0 — Foundations (1.5 weeks)

Nothing here is a feature, and all of it is the reason later features stay cheap.

- Monorepo (`apps/api`, `apps/web`, `packages/shared`), TypeScript strict, ESLint + Prettier
- **Module boundary enforcement** (dependency-cruiser + `no-restricted-imports`) — establish this on day one, because retrofitting boundaries onto a codebase that has ignored them is a rewrite
- Boot-time env validation (Zod), config module
- Mongo connection, **tenant-scope plugin, soft-delete plugin, transaction helper** `[D1]`
- AsyncLocalStorage request context, request-id middleware, pino logging
- Error taxonomy, response envelope, async handler
- Health endpoints, Docker Compose (Mongo + Redis + MinIO), CI (lint, typecheck, test)
- Test harness with tenant fixtures and **the isolation-test framework**

**Gate:** a scaffold module proves that a query without tenant context *throws*, and that tenant A cannot read tenant B.

---

## Milestone 1 — Identity & tenancy (2 weeks)

Users, memberships, tenants, roles, permission registry, invitations, refresh rotation with reuse detection, tenant onboarding, tenant switching, plan/subscription/entitlement scaffolding with usage counters.

Frontend: auth shell, app layout, navigation, permission gating, design-system primitives.

**Gate:** two organisations exist, a user belongs to both, switches between them, invites a colleague, and hits a plan limit. Isolation tests pass on every route so far.

---

## Milestone 2 — Directory & catalog (2 weeks)

People, departments, locations, cost centres (with `path[]` hierarchies). Asset types, categories, **custom field definitions**, the lifecycle workflow engine with a seeded default.

Frontend: `DataTable` built properly, `FilterBar`, **`FieldRenderer`**, the custom-field editor with live form preview.

**Gate:** an admin creates the asset type "Camera" with five custom fields including a select and a date, and the creation form renders correctly with no code written.

`DataTable` and `FieldRenderer` are the two components everything else depends on. Budget the time.

---

## Milestone 3 — Assets & assignment (2.5 weeks)

The asset aggregate with all indexes. CRUD, list with filtering (including custom fields), atomic tag generation, QR codes, soft delete and restore. Assign / return / transfer with the partial unique index `[D4]`, acknowledgement flow, lifecycle transitions. **Outbox + event bus + audit writer + timeline projector** `[D5]`.

Frontend: asset list, asset detail with tabs, assign/return drawers, timeline, scan-to-open.

**Gate:** two simultaneous assign requests — one succeeds, one gets a clean `409` naming the current holder. The timeline shows every change with actor, before and after.

---

## Milestone 4 — Documents, dashboard, notifications (2 weeks)

S3 presigned uploads with magic-byte verification and the pending sweeper. Metrics rollup job + dashboard endpoints. Notification dispatcher (in-app + email) with preferences. Warranty expiry scan. Offboarding flow.

Frontend: dashboard with the **Needs Attention** panel, notification centre, file upload, offboarding checklist.

**Gate:** a warranty expiring in 30 days appears on the dashboard and generates an email. Offboarding a person surfaces every asset they hold.

---

## Milestone 5 — Import & export (2 weeks)

The five-step staged import pipeline: upload → map → validate (dry run) → review → commit in idempotent batches. Row-level errors, downloadable error file, duplicate strategies, entitlement pre-check. Async export with formula-injection protection.

Frontend: the import wizard, error table, progress tracking.

**Gate:** a deliberately messy 5,000-row spreadsheet — wrong dates, missing fields, duplicate serials, one row that would breach the plan limit — is imported with clear per-row errors and a clean partial commit.

This milestone is the sales demo. Do not rush it.

---

## Milestone 6 — Hardening & launch (2 weeks)

Full isolation suite, permission matrix tests, load testing at 100k assets per tenant, index verification against real query plans (`explain()` on every list endpoint — **the plan is the proof, not the index definition**), rate limiting, security checklist, monitoring, alerting, runbooks, backup restore rehearsal, staging soak.

**Gate:** every item in [07-security.md](07-security.md) §11 is checked, and the p95 asset-list response at 100k assets is under 300 ms.

---

**MVP total: ~14 weeks / 3.5 months** with 2–3 engineers. Add 30% if the team is new to the stack.

---

## Post-MVP

| Release | Contents | Est. |
|---|---|---|
| **v1.1** | Vendors, maintenance, software & licences with seats, saved views, bulk edit, depreciation, scheduled reports, Atlas Search | 6 weeks |
| **v1.2** | Custom role builder, asset requests & approvals, purchase orders, webhooks + API keys + public API, MFA, contracts, check-out pools with due dates | 8 weeks |
| **v2** | SSO (SAML/OIDC) + SCIM, MDM/discovery integrations with field provenance, mobile scanning with offline queue, stocktake sessions, consumables & stock, kits/components | 12 weeks |

---

## Testing strategy

Weighted toward the tests that catch the failures that actually hurt this product.

| Layer | Coverage target | What it must cover |
|---|---|---|
| **Unit** | Services, policies, validators, lifecycle engine, permission resolution | Every business invariant: last-owner, privilege escalation, transition guards, entitlement checks |
| **Integration** | Routes against a real Mongo (Testcontainers) | Full request→DB→response, transactions, rollback on failure |
| **★ Tenant isolation** | **Every route, generated from the route table** | Tenant A cannot read/update/delete tenant B. A route without a test fails CI. Highest-value suite in the project |
| **★ Permission matrix** | Every route × every role | Generated from the route table and the permission registry; a new route with no declared permission fails CI |
| **Concurrency** | Assignment, tag generation, import commit | Parallel requests; assert exactly one winner and a clean conflict error |
| **Import/export** | Golden files | Malformed, huge, duplicate-laden, wrong-encoding, formula-injection fixtures |
| **Frontend** | Vitest + Testing Library; Playwright for the six core workflows | Onboarding, assign, return, offboarding, import, search-and-save-view |
| **Load** | k6 against a seeded 100k-asset tenant | List, search, dashboard, and import under concurrency |
| **Security** | Automated + manual | The §11 checklist; external pentest before the first enterprise deal |

The two starred suites are generated from the route table rather than hand-written. That is what makes them stay complete as the codebase grows — a hand-maintained isolation test suite is one forgotten PR away from being a false sense of security.

---

## Production readiness gate

Nothing ships to a paying customer until all of these hold.

**Security** — isolation suite green on every route · permission matrix green · security checklist complete · no secrets in repo history or image · dependency audit clean · pentest scheduled

**Performance** — `explain()` verified on every list endpoint, no `COLLSCAN` · p95 < 300 ms on core reads at 100k assets · dashboard < 150 ms from rollups · no unbounded queries · connection pool sized and monitored

**Reliability** — health endpoints wired to the LB · graceful shutdown draining in-flight requests and jobs · job retries with dead-letter and alerting · idempotency verified on every job and `POST` · Sentry with release tracking · alerts on error rate, queue depth, DB latency, and job failure

**Data** — automated backups with a **rehearsed restore** · retention TTLs configured · reconciliation jobs scheduled · tenant export and purge tested end to end

**Operations** — runbooks for the top ten incidents · documented rollback · migration strategy for schema evolution · on-call defined · status page

**Commercial** — entitlements enforced server-side and verified by test · grace period and read-only mode tested · tenant suspension and reactivation tested · data export available to every plan including lapsed ones

---

## What to build first, in one line

**Milestone 0's tenant-scope plugin and isolation-test framework.** Everything else can be refactored later. Those two cannot — they are the difference between a product an enterprise will buy and one they will not.
