# Phase 3 — Data Model

MongoDB. Every rule below assumes the tenant-scope plugin from [02-architecture.md](02-architecture.md) §3 is active.

---

## 1. Conceptual model

```
                        ┌────────┐
                        │  Plan  │  (global)
                        └───┬────┘
                            │ 1
                       ┌────▼─────────┐
              ┌────────│ Subscription │
              │        └────┬─────────┘
              │             │ 1
    ┌─────┐   │        ┌────▼───┐        ┌────────────┐
    │User │───┼───────▶│ Tenant │◀───────│ TenantUsage│
    └──┬──┘  N:M       └───┬────┘        └────────────┘
       │   (Membership)    │
       │                   │ owns everything below (tenantId on every doc)
       │              ┌────┴──────────────────────────────────────┐
       │              │                                           │
  ┌────▼──────┐  ┌────▼─────┐  ┌──────────┐  ┌──────────┐  ┌──────▼──────┐
  │Membership │  │  Person  │  │Department│  │ Location │  │ CostCentre  │
  │ roleIds[] │  │ ▲ ▲ ▲    │◀─┤          │  │          │  │             │
  └────┬──────┘  └─┼─┼─┼────┘  └──────────┘  └────┬─────┘  └─────────────┘
       │           │ │ │                          │
  ┌────▼───┐       │ │ │  manager (self-ref)      │
  │  Role  │       │ │ └──────────────────────────┘
  │ perms[]│       │ │
  └────────┘       │ │        ┌───────────────────┐
                   │ │        │    AssetType      │──┐
                   │ │        └─────────┬─────────┘  │
                   │ │        ┌─────────▼─────────┐  │ appliesTo
                   │ │        │  AssetCategory    │  │
                   │ │        └─────────┬─────────┘  │
                   │ │        ┌─────────▼─────────┐  │  ┌──────────────────────┐
                   │ │        │ LifecycleWorkflow │  │  │CustomFieldDefinition │
                   │ │        └─────────┬─────────┘  └─▶└──────────────────────┘
                   │ │                  │
                   │ │            ┌─────▼──────┐
                   │ └───────────▶│   ASSET    │◀──── parentAssetId (self, kits)
                   │  currentHolder└─┬──┬──┬──┬┘
                   │                 │  │  │  └──────────────┐
                   │      ┌──────────┘  │  └───────┐         │
                   │ ┌────▼──────────┐ ┌▼────────┐ │  ┌──────▼──────┐
                   └▶│AssetAssignment│ │AssetEvent│ │  │  Document   │
                     │  (partial     │ │(timeline)│ │  │  (S3 ref)   │
                     │   unique idx) │ └──────────┘ │  └─────────────┘
                     └───────────────┘              │
                     ┌───────────────┐  ┌───────────▼────┐  ┌──────────┐
                     │MaintenanceRec │  │    Vendor      │─▶│ Contract │
                     └───────────────┘  └───────┬────────┘  └──────────┘
                                                │
                     ┌──────────────┐   ┌───────▼────────┐   ┌──────────┐
                     │SoftwareProduct│──▶│    Licence     │──▶│LicenceSeat│─▶ Person/Asset
                     └──────────────┘   └────────────────┘   └──────────┘

  cross-cutting, tenant-scoped:
  OutboxEvent · AuditLog · Notification · ImportJob/ImportRow · ExportJob
  SavedView · Counter · MetricsDaily · WebhookEndpoint · ApiKey
```

---

## 2. Conventions applied to every collection

| Convention | Detail |
|---|---|
| `tenantId` | On every tenant-scoped document. **First key of every index without exception.** |
| Soft delete | `deletedAt: Date \| null`, `deletedBy`. A global plugin adds `deletedAt: null` to every query. Hard delete only via explicit purge jobs. |
| Timestamps | `createdAt`, `updatedAt`, `createdBy`, `updatedBy`. Always UTC. |
| Concurrency | `__v` used for optimistic locking on user-editable aggregates; a stale write returns `409 STALE_WRITE`. |
| Money | `{ amount: <integer minor units>, currency: 'GBP', fxRate?, fxDate? }`. Never a float, never a bare number. |
| References | `ObjectId` + a denormalised display field **only where the reference may be deleted and history must still render** (e.g. `actorNameSnapshot` is deliberately *not* used — see PII rule below). |
| PII in history | Audit and timeline store **references only**, never copied names or emails, so GDPR erasure works without destroying history. |
| Arrays | Never unbounded. Anything that grows without limit (assignments, events, seats) is its own collection. An asset with 4,000 timeline entries embedded would approach the 16 MB document cap. |

### The three index rules

1. **Every index starts with `tenantId`.** A non-prefixed index is useless (every query filters by tenant) and a non-prefixed *unique* index is a bug — it would make one tenant's serial number collide with another's.
2. **ESR order** — Equality fields, then Sort fields, then Range fields. This is the difference between an index scan and a collection scan with an in-memory sort.
3. **Every unique constraint is partial** — excluding soft-deleted documents, and excluding null/empty values where the field is optional.

---

## 3. Collections

### 3.1 Platform (global — exempt from tenant scoping)

#### `plans`
`key` · `name` · `entitlements{ seats, people, assets, storageBytes, customFields, customRoles, auditRetentionDays, apiAccess, sso, webhooks }` · `pricing[]` · `isPublic` · `sortOrder`

```
{ key: 1 }                     unique      — lookup by code
{ isPublic: 1, sortOrder: 1 }              — pricing page
```
Entitlements are **data, not code**. Adding a plan or granting a customer a one-off exception (via `subscription.entitlementOverrides`) never requires a deploy.

#### `tenants`
`name` · `slug` · `status(active|trialing|suspended|past_due|cancelled|deleted)` · `ownerUserId` · `settings{ timezone, locale, currency, dateFormat, assetTagPrefix, assetTagSequence, allowImpersonation }` · `branding` · `region` · `trialEndsAt` · `suspendedAt/Reason` · `deletionScheduledAt`

```
{ slug: 1 }                    unique      — subdomain / URL resolution
{ status: 1, createdAt: -1 }               — platform admin list
{ deletionScheduledAt: 1 }     sparse      — purge job scan
```
`settings.timezone` is why warranty and renewal boundaries are computed correctly — "expires today" is tenant-local.

#### `users` — global identity, deliberately thin
`email` (lowercased) · `emailVerifiedAt` · `passwordHash` (argon2id) · `name` · `avatarUrl` · `status` · `tokenVersion` · `mfa{}` · `lastLoginAt` · `failedLoginCount` · `lockedUntil` · `defaultTenantId`

```
{ email: 1 }                   unique, collation strength 2   — case-insensitive login
{ tokenVersion: 1 }                                            — global revocation
```
**A `User` is a login, not an employee.** Holds no tenant data — that lives on `Membership`. This is what makes one person's single account work across several customer organisations, and what keeps seat billing honest.

#### `refreshTokens`
`userId` · `familyId` · `tokenHash` (sha256) · `expiresAt` · `rotatedAt` · `revokedAt/Reason` · `ip` · `userAgent`

```
{ tokenHash: 1 }               unique      — presentation lookup
{ familyId: 1 }                            — reuse detection: revoke the family
{ userId: 1, revokedAt: 1 }                — "sign out everywhere", session list
{ expiresAt: 1 }               TTL 0       — self-cleaning
```

#### `subscriptions`
`tenantId` · `planId` · `status` · `seatsPurchased` · `currentPeriodStart/End` · `cancelAtPeriodEnd` · `entitlementOverrides{}` · `provider` · `providerRefs{}` · `graceEndsAt`

```
{ tenantId: 1 }                unique      — one active subscription per tenant
{ status: 1, currentPeriodEnd: 1 }         — renewal & dunning scans
```

#### `tenantUsage` — counters, so limits never require a `countDocuments()`
`tenantId` · `seatsUsed` · `peopleCount` · `assetCount` · `storageBytes` · `customFieldCount` · `lastRecalculatedAt`

```
{ tenantId: 1 }                unique
```
Updated with `$inc` inside the same transaction as the entity write, and fully recomputed nightly to correct drift. Counting 200,000 assets on every asset creation is not viable.

---

### 3.2 Identity within a tenant

#### `memberships` — user × tenant `[D2]`
`tenantId` · `userId` · `personId?` · `roleIds[]` · `scope{ type, departmentIds[], locationIds[] }` · `status(invited|active|suspended)` · `permVersion` · `invitedBy` · `joinedAt` · `lastActiveAt`

```
{ tenantId: 1, userId: 1 }     unique, partial deletedAt:null   — one membership per user per tenant
{ userId: 1, status: 1 }                                        — "which orgs am I in?" (login tenant picker)
{ tenantId: 1, status: 1, lastActiveAt: -1 }                    — member list
{ tenantId: 1, roleIds: 1 }                                     — "who are the Owners?" (last-owner guard)
```
`permVersion` increments on any role/scope change and invalidates both the Redis permission cache and outstanding access tokens.

#### `roles`
`tenantId?` (null = system role) · `key` · `name` · `description` · `permissions[]` · `isSystem` · `scopeType`

```
{ tenantId: 1, key: 1 }        unique, partial deletedAt:null
{ tenantId: 1, isSystem: 1 }
```
System roles have `tenantId: null` and are immutable. A tenant creating a custom role copies from a system role.

#### `invitations`
`tenantId` · `email` · `roleIds[]` · `tokenHash` · `invitedBy` · `expiresAt` · `acceptedAt` · `revokedAt`

```
{ tokenHash: 1 }               unique                                        — accept lookup
{ tenantId: 1, email: 1 }      unique, partial: acceptedAt/revokedAt null    — no duplicate live invites
{ expiresAt: 1 }               TTL 0
```

#### `people` — asset holders, **not necessarily users**
`tenantId` · `employeeCode` · `firstName` · `lastName` · `email` · `personalEmail?` · `phone` · `jobTitle` · `departmentId` · `locationId` · `costCentreId` · `managerId` (self-ref) · `membershipId?` · `type(employee|contractor|service_account)` · `status(active|on_leave|offboarding|inactive)` · `startDate` · `endDate` · `externalRefs[{system,id}]` · `cf{}` · `deletedAt`

```
{ tenantId: 1, status: 1, lastName: 1 }                       — default list, sorted (ESR)
{ tenantId: 1, email: 1 }       unique, partial: email exists & deletedAt:null
{ tenantId: 1, employeeCode: 1} unique, partial: code exists & deletedAt:null
{ tenantId: 1, departmentId: 1, status: 1 }                   — dept filter + scoped access
{ tenantId: 1, locationId: 1, status: 1 }                     — location filter + scoped access
{ tenantId: 1, managerId: 1 }                                 — direct reports, offboarding cascade
{ tenantId: 1, membershipId: 1 } sparse                       — person ⇄ login link
{ tenantId: 1, "externalRefs.system":1, "externalRefs.id":1 }  — SCIM/HRIS sync idempotency
{ tenantId: 1, searchTokens: 1 }                              — typeahead
```
`externalRefs` exists in v1 even though sync ships in v2 — retrofitting identity correlation onto records created by hand is painful, and adding an empty array now costs nothing.

#### `departments` / `locations` / `costCentres`
Shared shape: `tenantId` · `name` · `code` · `parentId` (self-ref, materialised `path[]`) · `managerId` · type-specific fields (locations add `address`, `timezone`).

```
{ tenantId: 1, parentId: 1, name: 1 }
{ tenantId: 1, code: 1 }       unique, partial: code exists & deletedAt:null
{ tenantId: 1, path: 1 }                    — "everything under London" subtree queries
```
`path[]` (array of ancestor ids) makes subtree queries a single indexed `$in`, avoiding recursive `$graphLookup` on every scoped list query. Recomputed on move via a background job.

---

### 3.3 Catalog

#### `assetTypes`
`tenantId` · `key` · `name` · `icon` · `categoryId` · `lifecycleWorkflowId` · `isSerialised` · `requiresSerial` · `tagPrefix` · `defaultDepreciation{}` · `status`

```
{ tenantId: 1, key: 1 }        unique, partial deletedAt:null
{ tenantId: 1, status: 1, name: 1 }
```
`isSerialised: false` is the seam for consumables/stock in v2 — the flag exists now so quantity-based items don't force a new collection later.

#### `assetCategories`
`tenantId` · `name` · `parentId` · `path[]` · `icon` · `colour`

```
{ tenantId: 1, parentId: 1, name: 1 }
{ tenantId: 1, path: 1 }
```

#### `customFieldDefinitions` `[D3]`
See [02-architecture.md](02-architecture.md) §6.3 for the full field list.

```
{ tenantId: 1, appliesTo: 1, key: 1 }  unique   — key immutable & unique per entity type
{ tenantId: 1, appliesTo: 1, status: 1, "display.order": 1 }   — form/table rendering
{ tenantId: 1, assetTypeIds: 1 }                                — fields for a given type
```

#### `lifecycleWorkflows`
`tenantId` · `name` · `isDefault` · `states[]` · `transitions[]` · `initialState` · `version`

```
{ tenantId: 1, isDefault: 1 }
```
`version` increments on edit; assets record `lifecycleVersion` so historical transitions stay interpretable after a workflow change.

---

### 3.4 The asset aggregate

#### `assets`
```
tenantId, assetTag, name, assetTypeId, categoryId, status/lifecycleState,
condition, serialNumber, imei, macAddresses[], model, brand, sku, barcode,
description, notes,

purchase:   { date, price{}, vendorId, poNumber, invoiceNumber, orderRef }
warranty:   { provider, startsAt, expiresAt, type, notes }
finance:    { depreciationMethod, usefulLifeMonths, salvageValue{}, bookValue{},
              lastDepreciatedAt, costCentreId }
placement:  { locationId, departmentId, subLocation }
currentAssignment: { assignmentId, assigneeType, assigneeId, assignedAt } | null   ◀ cache only
technical:  { os, osVersion, cpu, ramGb, storageGb, gpu, hostname, ipAddress,
              deviceId, isEncrypted, antivirusStatus, lastCheckInAt }
provenance: { source, externalRefs[], integrationManagedFields[] }
parentAssetId, isKit, cf{}, searchTokens[], attachmentCount,
lifecycleVersion, createdAt, updatedAt, deletedAt, __v
```

**Indexes — the ones that matter and why:**

```
{ tenantId:1, deletedAt:1, lifecycleState:1, updatedAt:-1 }
      Default list view. ESR: tenant+deleted+state are equality, updatedAt is the sort.
      This one index serves the most-hit screen in the product.

{ tenantId:1, assetTag:1 }        unique, partial deletedAt:null
      Asset tags must be unique per tenant. Partial so a deleted asset's tag can be reused.

{ tenantId:1, serialNumber:1 }    unique, partial: serialNumber non-empty AND deletedAt:null
      Serials are unique when present — but many legitimate assets (cables, adapters,
      furniture) have none. A plain unique index would allow exactly one null-serial asset
      per tenant. The partial filter is not an optimisation; it is a correctness requirement.

{ tenantId:1, categoryId:1, lifecycleState:1, updatedAt:-1 }
{ tenantId:1, placement.locationId:1, lifecycleState:1 }
{ tenantId:1, placement.departmentId:1, lifecycleState:1 }
      The three dimensions every dashboard tile and every scoped Manager query uses.
      Also what makes location/department permission scoping cheap.

{ tenantId:1, currentAssignment.assigneeId:1 }   sparse
      "What does this person hold?" — the offboarding screen and the employee's own view.
      Sparse because most assets in a healthy estate are assigned; unassigned ones skip it.

{ tenantId:1, warranty.expiresAt:1 }
      partial: expiresAt exists AND lifecycleState NOT IN (retired, disposed)
      Warranty pipeline widget and the nightly expiry scan. The partial filter keeps
      years of dead assets out of an index queried every night for every tenant.

{ tenantId:1, assetTypeId:1, "cf.$**":1 }     compound wildcard, MongoDB 7.0+
      Filter and sort on ANY custom field without knowing its name at schema time. [D3]
      Scoped by assetTypeId to keep the index from covering unrelated types.

{ tenantId:1, searchTokens:1 }    multikey
      Typeahead / quick search. Replaced by Atlas Search in v1.1.

{ tenantId:1, createdAt:-1, _id:-1 }
      Cursor pagination. _id breaks ties so a cursor is stable when timestamps collide.

{ tenantId:1, parentAssetId:1 }   sparse
      Kit/component children.
```

**Explicitly rejected:** embedding assignment history, maintenance records, or documents in the asset document. A five-year-old laptop accumulates hundreds of entries; unbounded arrays destroy write performance long before they hit the 16 MB cap, and they cannot be queried across assets.

#### `assetAssignments` `[D4]`
`tenantId` · `assetId` · `assigneeType(person|location|asset)` · `assigneeId` · `status(active|returned|cancelled)` · `assignedBy` · `assignedAt` · `dueAt?` · `acknowledgement{ requiredAt, acknowledgedAt, token, method, signatureDocId }` · `returnedAt` · `returnedTo` · `conditionOut` · `conditionIn` · `notes` · `previousAssignmentId`

```
{ tenantId:1, assetId:1 }   UNIQUE, partial: { status: 'active' }
      ★ The most important index in the system.
      The database physically prevents two active assignments for one asset.
      Concurrent assigns: one commits, the other gets E11000 → 409 ASSET_ALREADY_ASSIGNED.
      No locks, no read-then-write race, no reconciliation script.

{ tenantId:1, assigneeId:1, status:1, assignedAt:-1 }
      Everything a person holds now + their full history. Powers offboarding.

{ tenantId:1, assetId:1, assignedAt:-1 }
      Chain of custody for one asset.

{ tenantId:1, status:1, dueAt:1 }   partial: dueAt exists
      Overdue loans (v1.2 check-out pools).

{ tenantId:1, "acknowledgement.requiredAt":1 }
      partial: requiredAt exists AND acknowledgedAt is null   — pending acknowledgements
```

#### `assetEvents` — user-facing timeline
`tenantId` · `assetId` · `type` · `occurredAt` · `actorId` · `actorType(user|system|integration|import)` · `summary` · `changes[{ field, label, from, to }]` · `relatedIds{}` · `comment` · `sourceEventId` · `expiresAt`

```
{ tenantId:1, assetId:1, occurredAt:-1 }     — the asset detail timeline
{ tenantId:1, occurredAt:-1 }                 — tenant activity feed / dashboard
{ tenantId:1, actorId:1, occurredAt:-1 }      — "what did this user do?"
{ tenantId:1, type:1, occurredAt:-1 }         — filtered activity
{ sourceEventId: 1 }              unique      — outbox idempotency: redelivery cannot duplicate
{ expiresAt: 1 }                  TTL 0       — per-plan retention, set at write time
```
The TTL-on-a-per-document-`expiresAt` pattern gives per-tenant retention from a single index — MongoDB TTL is fixed per index, so the varying part has to live in the document. `[mongo-mitigation]`

---

### 3.5 Supporting collections

#### `maintenanceRecords`
`tenantId` · `assetId` · `type(repair|service|inspection|upgrade)` · `status` · `reportedBy` · `reportedAt` · `vendorId` · `ticketRef` · `startedAt` · `completedAt` · `nextServiceDueAt` · `cost{}` · `isUnderWarranty` · `description` · `resolution` · `partsReplaced[]`

```
{ tenantId:1, assetId:1, reportedAt:-1 }
{ tenantId:1, status:1, reportedAt:-1 }
{ tenantId:1, nextServiceDueAt:1 }   partial: exists AND status != cancelled   — due scan
{ tenantId:1, vendorId:1, completedAt:-1 }                                     — vendor spend
```

#### `vendors` / `contracts`
Vendor: `name` · `code` · `category` · `contacts[]` · `website` · `address` · `taxId` · `paymentTerms` · `rating` · `status` · `cf{}`
Contract: `vendorId` · `type(support|lease|saas|warranty)` · `reference` · `startsAt` · `endsAt` · `autoRenew` · `noticePeriodDays` · `value{}` · `documentIds[]`

```
vendors:   { tenantId:1, status:1, name:1 } · { tenantId:1, code:1 } unique partial
contracts: { tenantId:1, vendorId:1, endsAt:-1 }
           { tenantId:1, endsAt:1 } partial: autoRenew or active — renewal pipeline
```

#### `softwareProducts` / `licences` / `licenceSeats`
Splitting seats into their own collection is deliberate: a 5,000-seat licence with embedded assignees would be an unbounded array, and "which licences does this person hold?" would require scanning every licence.

```
licences:     { tenantId:1, status:1, expiresAt:1 }
              { tenantId:1, softwareProductId:1 }
              { tenantId:1, expiresAt:1 } partial: exists & status active  — renewal scan

licenceSeats: { tenantId:1, licenceId:1, assigneeId:1 } UNIQUE partial: status 'active'
                    — one active seat per assignee per licence (same trick as assignments)
              { tenantId:1, assigneeId:1, status:1 }
                    — "what software does this person have?" and offboarding reclamation
              { tenantId:1, licenceId:1, status:1 }
                    — utilisation: seats used vs. purchased
```

#### `documents`
`tenantId` · `entityType` · `entityId` · `category` · `fileName` · `contentType` (**verified server-side**) · `sizeBytes` · `storageKey` · `checksum` · `status(pending|ready|infected|deleted)` · `scanResult` · `uploadedBy`

```
{ tenantId:1, entityType:1, entityId:1, createdAt:-1 }   — attachments on a record
{ storageKey: 1 }                       unique            — no orphan / no collision
{ status:1, createdAt:1 }  partial: status 'pending'      — sweeper for abandoned uploads
{ tenantId:1, createdAt:-1 }                              — storage accounting
```

#### `notifications`
`tenantId` · `recipientId` · `type` · `title` · `body` · `entityRef{}` · `actionUrl` · `readAt` · `channels[]` · `deliveredAt` · `expiresAt`

```
{ tenantId:1, recipientId:1, readAt:1, createdAt:-1 }   — inbox + unread badge (ESR)
{ expiresAt:1 }   TTL 0
```

#### `auditLogs` — append-only
`tenantId` · `occurredAt` · `actorId` · `actorType` · `actorIp` · `userAgent` · `action` · `entityType` · `entityId` · `changes[]` · `metadata` · `requestId` · `outcome(success|denied|error)` · `prevHash` · `hash` · `expiresAt`

```
{ tenantId:1, occurredAt:-1 }                             — audit browser
{ tenantId:1, entityType:1, entityId:1, occurredAt:-1 }   — "history of this record"
{ tenantId:1, actorId:1, occurredAt:-1 }                  — user activity review
{ tenantId:1, action:1, occurredAt:-1 }                   — "all permission changes"
{ tenantId:1, outcome:1, occurredAt:-1 } partial: outcome 'denied'  — attack detection
{ expiresAt:1 }   TTL 0                                   — per-plan retention
```
No update or delete route exists for this collection at any role. `prevHash`/`hash` form an optional per-tenant chain so tampering is detectable, not merely discouraged.

#### `outboxEvents` `[D5]`
`tenantId` · `type` · `payload` · `actorId` · `occurredAt` · `status(pending|processing|done|failed)` · `attempts` · `availableAt` · `lastError` · `subscribersCompleted[]`

```
{ status:1, availableAt:1 }              — the dispatcher's only query; must be tight
{ tenantId:1, occurredAt:-1 }            — debugging / replay
{ status:1, occurredAt:1 } partial: status 'failed'   — dead-letter review
{ occurredAt:1 }  TTL 30d partial: status 'done'      — self-cleaning
```

#### `importJobs` / `importRows`
Job: `entityType` · `fileName` · `storageKey` · `status(uploaded|mapping|validating|preview|committing|completed|failed|cancelled)` · `columnMapping{}` · `options{ duplicateStrategy, dryRun }` · `counts{ total, valid, invalid, created, updated, skipped, failed }` · `errorFileKey`
Row: `importJobId` · `rowNumber` · `raw{}` · `normalised{}` · `errors[]` · `status` · `resultEntityId` · `rowHash`

```
importJobs: { tenantId:1, status:1, createdAt:-1 }
importRows: { importJobId:1, rowNumber:1 }                 — ordered review
            { importJobId:1, status:1 }                     — error-only view
            { importJobId:1, rowHash:1 }  unique            — ★ commit idempotency:
                  a retried or resumed commit cannot create the same row twice
            { createdAt:1 }  TTL 30d                        — staging data is disposable
```

#### `savedViews`
`tenantId` · `ownerId` · `entityType` · `name` · `filters[]` · `sort` · `columns[]` · `visibility(private|team|tenant)` · `isDefault`

```
{ tenantId:1, entityType:1, ownerId:1 }
{ tenantId:1, entityType:1, visibility:1 }   — shared views
```

#### `counters` — atomic sequences
`_id` = `"{tenantId}:assetTag"` · `seq`

Asset tags are generated with a single `findOneAndUpdate({_id}, {$inc:{seq:1}}, {upsert, returnDocument:'after'})`. **Generating a tag by counting existing assets or reading max+1 is a race** that produces duplicate tags under concurrent creation — including during a parallel import. This collection exists specifically to prevent that.

#### `metricsDaily`
`tenantId` · `date` · `metrics{ totalAssets, byState{}, byCategory{}, byLocation{}, assignedCount, totalValue{}, expiringWarranties30d, ... }`

```
{ tenantId:1, date:-1 }   unique   — dashboard reads this, never the asset collection
```

---

## 4. Transactions

MongoDB multi-document transactions (replica set / Atlas) are used where two writes must not diverge:

| Operation | Inside one transaction |
|---|---|
| Assign / return / transfer | Assignment doc + `asset.currentAssignment` + outbox event |
| Asset create | Asset + tag counter + `tenantUsage.$inc` + outbox event |
| Import commit (per batch) | N assets + counters + usage + outbox events |
| Member invite accept | Membership + person link + usage seat `$inc` + outbox event |
| Licence seat allocate | Seat + licence used-count + outbox event |
| Document confirm | Document status + `tenantUsage.storageBytes` |

Transactions stay short (< 1s) and never wrap an external HTTP call. Import commits batch ~500 rows per transaction rather than wrapping the whole file — a 50,000-row single transaction will exceed the transaction size limit and hold locks far too long.

---

## 5. Data lifecycle

| Stage | Mechanism |
|---|---|
| **Soft delete** | `deletedAt` set; global query plugin excludes; unique partial indexes free the tag/serial for reuse |
| **Restore** | Available for 30 days from a trash view; blocked if the freed unique value has since been claimed |
| **Referenced-entity delete** | Blocked with a count (`"3 assets use this category"`) and an offer to reassign-then-archive. Categories, locations, departments, vendors and asset types are **archived, never deleted**, while references exist |
| **Retention** | TTL indexes on `expiresAt`, populated at write time from the tenant's plan retention |
| **Tenant suspension** | Reads allowed, writes rejected `402/403`. No data touched |
| **Tenant deletion** | `deletionScheduledAt` = +30 days → export offered → purge job removes documents by `tenantId` and S3 objects by `t/{tenantId}/` prefix → tombstone retained for legal/billing |
| **GDPR erasure of a person** | PII fields nulled, record tombstoned, `externalRefs` cleared. **Assignment and audit records survive** because they hold references, not name copies — history stays intact, the person does not |

---

## 6. Referential integrity without foreign keys `[mongo-mitigation]`

Mongo will not do this for us, so it is done deliberately in three layers:

1. **Write-time validation** — the service verifies referenced ids exist and belong to the same tenant before writing. Never trust an id from a request body.
2. **Delete-time guards** — a reference count check before archive/delete, surfaced to the user with the actual blocking records rather than a generic error.
3. **A nightly integrity job** — scans for orphans (assets pointing at deleted categories, assignments pointing at deleted people, documents with no S3 object, `currentAssignment` disagreeing with the assignment collection), auto-repairs the safe cases and raises an alert for the rest.

Layer 3 is the one teams skip, and it is the one that catches the bug the other two missed.
