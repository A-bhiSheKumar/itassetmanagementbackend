# Phase 4 — API Design

REST over JSON. Versioned at `/api/v1`. Every response has the same shape, every list endpoint takes the same parameters, every error uses the same taxonomy. Consistency here is what makes the frontend, the docs, and the future public API cheap.

---

## 1. Response envelope

**Success**
```json
{ "success": true, "data": { }, "meta": { "requestId": "req_01HZ..." } }
```

**List**
```json
{
  "success": true,
  "data": [ ],
  "meta": {
    "requestId": "req_01HZ...",
    "pagination": { "cursor": "eyJjIjoi...", "hasMore": true, "limit": 50 },
    "total": 1284,
    "totalIsEstimate": false
  }
}
```

**Error**
```json
{
  "success": false,
  "error": {
    "code": "ASSET_ALREADY_ASSIGNED",
    "message": "This asset is already assigned to Priya Raman.",
    "details": { "assignmentId": "...", "assigneeId": "..." },
    "fields": { "serialNumber": ["Already used by asset LAP-0042"] }
  },
  "meta": { "requestId": "req_01HZ..." }
}
```

`code` is a stable machine-readable enum — the client branches on it, never on `message`. `message` is human-readable and localisable. `fields` maps directly onto form fields so validation errors render inline with no client-side mapping.

`requestId` appears in the response, in every log line, and in Sentry. A customer pastes it into support and we find the exact request.

---

## 2. Conventions

| Concern | Rule |
|---|---|
| Paths | Plural kebab-case nouns: `/assets`, `/asset-types`, `/custom-fields` |
| Nesting | One level maximum: `/assets/:id/documents`. Deeper relationships get top-level resources with filters |
| Methods | `GET` read · `POST` create · `PATCH` partial update · `PUT` full replace (rare) · `DELETE` soft delete |
| Actions | Verbs that aren't CRUD are sub-resources: `POST /assets/:id/assign`, `POST /assets/:id/transition`. Not `POST /assets/assign?id=` |
| IDs | Opaque strings. Clients never parse or construct them |
| Dates | ISO 8601 UTC with `Z`. Date-only fields use `YYYY-MM-DD` |
| Money | `{ "amount": 129900, "currency": "GBP" }` — integer minor units, always |
| Nulls | `null` means "explicitly cleared". An absent key in a `PATCH` means "unchanged" |
| Casing | `camelCase` throughout |
| Idempotency | `Idempotency-Key` header honoured on all `POST`s; the response is cached for 24h against the key |
| Tenant | **Never in the URL, body, query or a header.** Derived from the access token, always |

### Status codes

`200` ok · `201` created · `202` accepted (async job started) · `204` no content · `400` malformed · `401` unauthenticated · `403` authenticated but not permitted · `404` not found **or not in your tenant** · `409` conflict (duplicate, stale write, already assigned) · `422` semantic validation failure · `402` payment required (subscription lapsed) · `429` rate limited · `500` / `503`.

**403 vs 404 matters.** Requesting another tenant's asset returns `404`. A `403` would confirm the resource exists — an enumeration oracle. Within your own tenant, a permission failure is a genuine `403`.

---

## 3. List endpoints

Every collection endpoint accepts the same parameters.

```
GET /api/v1/assets
  ?filter[lifecycleState]=deployed,in_stock     comma = OR within a field
  &filter[categoryId]=cat_123
  &filter[purchase.date][gte]=2024-01-01        operators: eq ne gt gte lt lte in nin
  &filter[cf.n.ram_gb][gte]=16                  custom fields filter identically
  &filter[warranty.expiresAt][lte]=2026-12-31
  &q=MacBook                                    free-text search
  &sort=-updatedAt                              - prefix = descending
  &limit=50                                     max 100
  &cursor=eyJjIjoi...                           cursor pagination
  &fields=id,name,assetTag,currentAssignment    sparse fieldsets
  &include=assignee,category,location           expand references
```

**Filters across fields are AND, values within a field are OR.** Advanced boolean logic is a `POST /assets/search` with a JSON filter tree — kept off the query string rather than inventing an encoding for it.

**Cursor pagination is the default** for assets, events, audit logs and people. Offset pagination is available (`page`/`pageSize`, capped at page 100) only for small admin tables. Deep offsets over 100k documents force Mongo to walk every skipped document; a cursor over `{tenantId, createdAt, _id}` is O(1) regardless of depth and is stable while data is being written.

`total` is omitted or flagged `totalIsEstimate` on very large filtered sets — a real count is a second full index scan and rarely worth it.

**Custom fields are first-class in the query language.** `filter[cf.n.ram_gb][gte]=16` works because of the type-bucketed storage `[D3]` — the value is stored as a number, so `gte` means what it should.

---

## 4. Endpoint map

### Auth & identity
```
POST   /auth/register                  create user + tenant (onboarding)
POST   /auth/login                     → user + membership list
POST   /auth/select-tenant             → tenant-scoped access token
POST   /auth/refresh                   rotating, reuse-detecting
POST   /auth/logout                    revoke family
POST   /auth/verify-email  /resend-verification
POST   /auth/forgot-password  /reset-password
POST   /auth/accept-invitation
GET    /me                             profile + memberships + effective permissions
PATCH  /me
POST   /me/change-password
GET    /me/sessions       DELETE /me/sessions/:id
```

### Tenant
```
GET    PATCH  /tenant                          settings, branding, timezone
GET    PATCH  /tenant/settings
GET    /tenant/usage                            counters vs. entitlements
POST   /tenant/transfer-ownership
POST   /tenant/request-deletion
GET    POST   /members                          list / invite
PATCH  DELETE /members/:id
POST   /members/:id/resend-invite  /suspend  /reactivate
GET    POST   /roles       GET PATCH DELETE /roles/:id
GET    /permissions                             the registry — drives the role editor UI
```

### Directory
```
GET POST /people      GET PATCH DELETE /people/:id
GET    /people/:id/assets            currently held
GET    /people/:id/history           full chain of custody
POST   /people/:id/start-offboarding → returns the checklist
POST   /people/:id/deactivate
GET POST PATCH DELETE  /departments  /locations  /cost-centres
```

### Catalog
```
GET POST PATCH DELETE  /asset-types  /asset-categories
GET POST PATCH         /custom-fields
POST   /custom-fields/:id/archive  /restore  /purge     purge = async, Owner only
GET POST PATCH         /lifecycle-workflows
```

### Assets — the core
```
GET    /assets                          list, filter, sort, paginate
POST   /assets
GET    /assets/:id                      ?include=assignee,category,location,vendor
PATCH  /assets/:id                      If-Match / __v for optimistic locking
DELETE /assets/:id                      soft
POST   /assets/:id/restore
POST   /assets/:id/duplicate
GET    /assets/:id/timeline             cursor-paginated
GET    /assets/:id/assignments
GET    /assets/:id/maintenance
GET    /assets/:id/documents
GET    /assets/:id/qr                   PNG or SVG
GET    /assets/by-tag/:assetTag         ★ what the QR code resolves to
POST   /assets/bulk                     { ids[] | filter, action, payload }  → 202 job
POST   /assets/:id/transition           { to, comment, fields }  → lifecycle engine

POST   /assets/:id/assign               { assigneeType, assigneeId, dueAt?,
                                          requireAcknowledgement? }
POST   /assets/:id/return               { condition, notes, returnedTo }
POST   /assets/:id/transfer             { toAssigneeId, ... }   atomic return+assign
GET    /assignments                     cross-asset view
POST   /assignments/:id/acknowledge     employee-facing
```

### Everything else
```
/maintenance        /vendors        /contracts
/software-products  /licences       /licences/:id/seats
/documents          POST /documents/presign-upload   POST /documents/:id/confirm
                    GET  /documents/:id/download     → 302 to presigned URL
/notifications      POST /notifications/read-all     /notification-preferences
/audit-logs         read-only, no write routes exist at any role
/saved-views
/dashboard/summary  /dashboard/warranty-pipeline  /dashboard/recent-activity
/reports            POST /reports/:key/run → 202 job   GET /reports/runs/:id
/search             cross-entity
/imports            POST /imports → 202 · GET /imports/:id · GET /imports/:id/rows
                    POST /imports/:id/mapping · /validate · /commit · /cancel
                    GET  /imports/:id/errors.csv · GET /imports/templates/:entityType
/exports            POST /exports → 202 · GET /exports/:id
```

### Platform (super admin, separate router, separate auth guard)
```
GET    /platform/tenants          GET /platform/tenants/:id
POST   /platform/tenants/:id/suspend  /reactivate
POST   /platform/tenants/:id/impersonate    ★ reason required, time-boxed,
                                              audited, blockable per tenant
GET    /platform/plans  /subscriptions  /metrics  /audit-logs  /health
```

---

## 5. Async operations

Anything that could exceed ~2 seconds returns `202` with a job handle rather than blocking:

```
POST /imports                     → 202 { jobId, status: 'queued', statusUrl }
GET  /imports/:jobId              → { status, progress: { done, total }, counts, result }
```

Applies to imports, exports, reports, bulk operations, custom-field purges, and tenant data exports. The client polls `statusUrl` (or, later, subscribes via SSE). This is the difference between a system that works at 500 assets and one that works at 500,000.

---

## 6. Validation

Zod schemas at the route boundary, in **strict mode** — unknown keys are rejected rather than stripped. This kills mass-assignment (`{ "role": "owner", "tenantId": "..." }` in a profile update never reaches a service) and NoSQL injection (`{"email": {"$ne": null}}` fails the type check) in one move.

Custom fields are validated against a Zod schema compiled from the tenant's `CustomFieldDefinition[]`, cached by `(tenantId, assetTypeId, definitionsVersion)`.

The response mapper is equally strict: DTOs are explicit allowlists. A model never serialises directly to JSON — that is how `passwordHash` and internal flags leak.

---

## 7. Error taxonomy

| Code | Status | When |
|---|---|---|
| `VALIDATION_FAILED` | 422 | Schema or business-rule violation; `fields` populated |
| `UNAUTHENTICATED` / `TOKEN_EXPIRED` | 401 | Missing/expired token — client refreshes and retries once |
| `PERMISSION_DENIED` | 403 | Authenticated, lacks the permission |
| `NOT_FOUND` | 404 | Missing, soft-deleted, **or another tenant's** |
| `DUPLICATE_VALUE` | 409 | Unique constraint; `details.field` names it |
| `ASSET_ALREADY_ASSIGNED` | 409 | The partial-unique-index conflict `[D4]` |
| `STALE_WRITE` | 409 | Optimistic-lock version mismatch |
| `INVALID_TRANSITION` | 422 | Lifecycle engine rejected the state change |
| `ENTITLEMENT_EXCEEDED` | 402 | Plan limit hit; `details` has limit, current, and upgrade URL |
| `SUBSCRIPTION_INACTIVE` | 402 | Lapsed/suspended tenant attempting a write |
| `RESOURCE_IN_USE` | 409 | Delete blocked; `details.references` lists blockers |
| `LAST_OWNER` | 409 | Removing/demoting the final Owner |
| `RATE_LIMITED` | 429 | `Retry-After` header set |

Every error thrown is an `AppError` subclass carrying its own code and status. A single error middleware converts it, logs with `requestId`, and reports 5xx to Sentry. **No stack traces or driver messages ever reach a client** — a raw Mongo `E11000` string leaks collection and index names.

---

## 8. Rate limiting

Redis-backed sliding window, applied on three independent dimensions so one noisy tenant cannot degrade another:

| Scope | Limit |
|---|---|
| Per IP, unauthenticated | 20 req/min (login, register, reset) |
| Per user | 300 req/min |
| Per tenant | scaled to plan |
| Auth endpoints | 5 attempts / 15 min per account **and** per IP, with progressive lockout |
| Exports / imports / reports | 10/hour per tenant |
| Invitations | 50/day per tenant — anti-spam |

Headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, plus `Retry-After` on 429.

---

## 9. Documentation & contract

OpenAPI 3.1, **generated from the Zod schemas** so it cannot drift from the implementation. Served at `/api/v1/docs`. TypeScript client types are generated from the same spec into the frontend, which makes a breaking API change a frontend compile error rather than a runtime surprise.

**Versioning policy:** additive changes ship into `v1`. Breaking changes create `v2`, with `v1` supported for 12 months and a deprecation header on every response. Worth committing to now — it constrains the public API in v1.2 in a way that is much harder to introduce later.
