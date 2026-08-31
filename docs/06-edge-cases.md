# Edge Cases — Specified Behaviour

Every row is a decision made *before* implementation. "Undefined" is not an acceptable value in this table.

Legend: **[brief]** = listed in the original requirements · **[added]** = not in the brief, found during design.

---

## 1. People & assignment

| # | Case | Specified behaviour |
|---|---|---|
| 1 | **[brief]** Employee deleted while holding assets | Hard delete is not available. `DELETE /people/:id` soft-deletes and is **blocked** while active assignments exist → `409 RESOURCE_IN_USE` listing them. The path is: offboard → return assets → deactivate. |
| 2 | **[brief]** Employee deactivated while holding assets | Deactivation is allowed but **opens an offboarding record**. Each held asset moves to `pending_return` and appears on the dashboard's Needs Attention panel. Assignments are never silently dropped. An Owner may force-complete with a mandatory reason, which is audited. |
| 3 | **[brief]** Asset transferred between employees | One atomic operation (`POST /assets/:id/transfer`): close the old assignment, open the new one, update the cached pointer, emit one `asset.transferred` event — all in a single transaction. Never two independent calls the user must remember to sequence. |
| 4 | **[brief]** Assignment conflict / **[brief]** concurrent updates | Prevented by the partial unique index on `(assetId)` where `status='active'` `[D4]`. The losing writer receives `409 ASSET_ALREADY_ASSIGNED` naming the current holder, plus an inline "transfer instead?" action. Field-level concurrent edits use `__v` optimistic locking → `409 STALE_WRITE` with a diff of what changed. |
| 5 | **[added]** Person deleted under GDPR while history exists | PII fields are nulled and the record tombstoned. Assignment and audit records survive because they store **references**, not name copies; the UI renders "Deleted person (ref 7f3a)". History is preserved, the individual is not identifiable. |
| 6 | **[added]** Employee holds a licence seat when offboarded | Seats appear on the offboarding checklist alongside hardware. Reclaiming a seat is a checklist item, not an afterthought — this is where money leaks in real deployments. |
| 7 | **[added]** Person is their own manager, or a manager cycle exists | Rejected at write time with a cycle check on the `managerId` chain. |
| 8 | **[added]** Manager is deactivated with direct reports | Deactivation is allowed; reports are flagged "manager needs reassigning" on the People screen. Not blocked — blocking here would make offboarding a chain reaction. |

## 2. Assets & catalog

| # | Case | Specified behaviour |
|---|---|---|
| 9 | **[brief]** Asset deleted while history exists | Soft delete only. The asset disappears from lists, its timeline and audit records remain, and it is visible in the trash view for 30 days. Hard purge only via a tenant-level data operation. |
| 10 | **[brief]** Duplicate serial numbers | Unique per tenant via a **partial** index — enforced only when the serial is non-empty and the asset is not deleted. Assets legitimately without a serial (cables, adapters, furniture) are unaffected. A plain unique index would permit exactly one null-serial asset per tenant, which is a bug, not a policy. |
| 11 | **[brief]** Duplicate asset tags | Same partial-unique pattern. Tags are generated atomically from the `counters` collection — **never** from `count()+1` or `max+1`, both of which race and produce duplicates during parallel imports. |
| 12 | **[brief]** Category / location / vendor deleted while referenced | Delete is blocked → `409 RESOURCE_IN_USE` with the count and a link to the affected records. The offered action is "reassign to X, then archive". Archived entities stay resolvable on historical records but no longer appear in pickers. |
| 13 | **[brief]** Custom field removed while assets use it | **Archive, don't delete.** The field vanishes from forms, tables and filters; values remain on documents; the action is fully reversible. Purge is a separate, explicitly confirmed, Owner-only background `$unset` that is audited. |
| 14 | **[brief]** Custom asset type deleted | Blocked while assets reference it. Archive instead — existing assets keep working and rendering, the type stops appearing in creation menus. |
| 15 | **[added]** Custom field type changed (text → number) | **Not permitted.** The path is archive + create new, optionally with a migration job that previews the conversion and reports every row it cannot convert. Silent coercion loses data irrecoverably. |
| 16 | **[added]** A select option is renamed or removed | Options carry stable ids; stored values reference the id, not the label. Renaming is free. Removing archives the option — existing values still render, the option leaves the dropdown. |
| 17 | **[added]** Asset restored from trash after its tag was reused | Restore is blocked with an explanation and an offer to restore under a newly generated tag. |
| 18 | **[added]** Lifecycle workflow edited while assets sit in a now-deleted state | Workflows are versioned; assets store `lifecycleVersion`. Assets in an orphaned state are listed with a required "migrate to state X" bulk action. They are never silently moved. |
| 19 | **[added]** An integration (MDM) overwrites a human-edited field | `provenance.integrationManagedFields[]` declares which fields the integration owns. Human edits to an owned field warn and are reverted on the next sync unless the field is explicitly unpinned. Without this, sync silently destroys people's work and they stop trusting the tool. |

## 3. Tenancy, users, permissions

| # | Case | Specified behaviour |
|---|---|---|
| 20 | **[brief]** Tenant subscription expires | Grace period (14 days) with a persistent banner → then **read-only**: all `GET`s and exports work, writes return `402 SUBSCRIPTION_INACTIVE`. Data is never deleted or hidden. Customers must always be able to get their data out. |
| 21 | **[brief]** Tenant suspended (by us) | All access blocked except login, billing, and data export. A clear reason is shown. Reversible with no data loss. |
| 22 | **[brief]** User belongs to multiple organisations | First-class, via the `Membership` model `[D2]`. Login lists memberships; selecting one mints a tenant-scoped token. Switching is a token exchange, not a re-login. |
| 23 | **[brief]** User changes organisation | Old membership is suspended, new one created. `Person` records are tenant-scoped and do not move. Assignment history stays with the original tenant, correctly. |
| 24 | **[brief]** Last company admin deletion / demotion | Blocked → `409 LAST_OWNER`. A tenant must always have exactly one Owner; ownership must be transferred first. Applies to delete, demote, suspend, and self-demotion. |
| 25 | **[brief]** Admin loses permissions mid-session | `permVersion` on the membership increments, invalidating the permission cache and outstanding access tokens. Effective within one access-token lifetime (15 min) at worst, immediately on the next refresh. Destructive actions re-check against the database regardless. |
| 26 | **[added]** Invitation sent to an email that already has an account | No duplicate `User`. A new `Membership` is linked to the existing user, who sees the new organisation on next login. |
| 27 | **[added]** Same email invited twice to the same tenant | Partial unique index on `(tenantId, email)` for live invitations. The second attempt resends rather than duplicating. |
| 28 | **[added]** Someone tries to grant a permission they don't hold | Rejected. An actor can only grant permissions within their own effective set, and cannot edit a role granting more than they hold. Explicitly tested. |
| 29 | **[added]** Super Admin accesses tenant data | Only via time-boxed impersonation with a mandatory reason. Visibly bannered in the UI, fully audited, and blockable per tenant on Enterprise (`settings.allowImpersonation: false`). Super Admin has **no** default read access to tenant business data. |
| 30 | **[added]** Tenant slug collides or is changed | Slugs are unique and immutable after creation. A vanity change creates a redirect record; the old slug is reserved permanently to prevent takeover. |

## 4. Import / export

| # | Case | Specified behaviour |
|---|---|---|
| 31 | **[brief]** Import partially fails | Rows are staged and validated before anything is written. The commit runs in ~500-row transactional batches; a failed batch rolls back only itself. The user gets `1,180 created · 43 failed` with a downloadable error file, and can fix and re-upload only the failures. |
| 32 | **[brief]** Duplicate imports (same file twice) | Every staged row carries a `rowHash`; `(importJobId, rowHash)` is unique, so a retried or resumed commit cannot double-create. Across jobs, duplicate detection on serial/tag offers skip / update / create-anyway as an explicit choice. |
| 33 | **[brief]** Invalid Excel structure / missing headers | Caught at the mapping step, before any data is read. Unmappable required fields block progress with a plain-language explanation of which column is missing. |
| 34 | **[brief]** Missing required fields | Row-level error naming the field and the row number, shown in the error table with the offending cell in context. The row is skipped, not guessed at. |
| 35 | **[brief]** Large file upload | Uploads go straight to S3 via presigned PUT; the API never buffers the file. Size cap by plan. Parsing is streamed, never `readFileSync`. |
| 36 | **[added]** Two imports running concurrently in one tenant | Import queue concurrency is **1 per tenant**. The second job queues. Concurrent imports of overlapping data are the classic duplicate-creation bug. |
| 37 | **[added]** User closes the browser mid-import | Irrelevant — the job runs server-side. They get a notification on completion and can reopen the job at any time. |
| 38 | **[added]** Import would exceed the plan asset limit | Blocked at the **validation** step, not partway through the commit, with the exact overage and an upgrade link. Never half-import and then stop. |
| 39 | **[added]** CSV formula injection on export | Cells beginning with `= + - @ tab CR` are prefixed with `'` on export. Otherwise our export becomes a command-execution vector inside the customer's Excel — a real, commonly-missed vulnerability. |
| 40 | **[added]** Import references a category/location that doesn't exist | Configurable: reject the row, or auto-create the missing entity. Default is reject — auto-creation from a typo-ridden spreadsheet generates a mess that is tedious to clean up. |

## 5. Files, money, time

| # | Case | Specified behaviour |
|---|---|---|
| 41 | **[added]** Uploaded file's real type differs from its declared type | Magic bytes verified server-side after upload. Mismatch → rejected and the object deleted. Client-declared MIME type is never trusted. |
| 42 | **[added]** Upload starts but is never confirmed | `pending` documents older than 24h and their S3 objects are removed by a sweeper. Storage is not counted until confirmed. |
| 43 | **[added]** Storage entitlement exceeded | Presign is refused → `402 ENTITLEMENT_EXCEEDED` with current usage. Existing files stay downloadable — never hold a customer's data hostage. |
| 44 | **[added]** Assets purchased in multiple currencies | Stored as minor units + ISO code + the FX rate captured at purchase date. Reports show either the original currency or a converted total with the conversion basis stated. A "total value" that silently sums mixed currencies is worse than no number. |
| 45 | **[added]** "Warranty expires today" across time zones | All storage UTC; day boundaries computed in the tenant's configured timezone. A Sydney tenant and a Los Angeles tenant get different, correct answers. |
| 46 | **[added]** Asset purchased before the tenant existed / future-dated | Allowed — estates are imported with historical data. Warned if the date is more than 30 days in the future (usually a typo or a date-format mix-up). |
| 47 | **[added]** DD/MM vs MM/DD ambiguity in imports | Date format is chosen explicitly at the mapping step, defaulting to the tenant locale, with a preview of three parsed sample rows. Never guessed. |

## 6. Scale & operations

| # | Case | Specified behaviour |
|---|---|---|
| 48 | **[added]** A tenant with 500,000 assets loads the dashboard | Dashboard reads `metricsDaily` rollups, never the asset collection. Constant time regardless of estate size. |
| 49 | **[added]** A user paginates to page 5,000 | Cursor pagination by default; offset is capped at page 100 with a prompt to filter or export instead. Deep offsets force Mongo to walk every skipped document. |
| 50 | **[added]** A report would return 200,000 rows | Runs as an async job → downloadable file. No HTTP response ever streams an unbounded result set. |
| 51 | **[added]** One tenant's scheduled scan starves the others | Scheduled jobs iterate tenants in batches with per-tenant concurrency limits, not one global collection scan. |
| 52 | **[added]** A webhook endpoint is down | Exponential backoff, capped retries, then dead-letter with a tenant-visible failure record and endpoint auto-disable after sustained failure. **A failing webhook never fails the user's request** — it is dispatched from the outbox, after commit. |
| 53 | **[added]** `asset.currentAssignment` drifts from the assignment collection | It shouldn't — both are written in one transaction — but a nightly reconciliation job asserts agreement, repairs the cache, and alerts. Every denormalised field gets a reconciliation job; that is the price of denormalising. |
| 54 | **[added]** An outbox event is delivered twice | Every subscriber is idempotent on `eventId`. `assetEvents.sourceEventId` is unique, so redelivery cannot duplicate a timeline entry. |
| 55 | **[added]** A tenant requests deletion, then changes their mind | 30-day scheduled deletion with the data intact and read-only. Cancellable throughout. Purge is irreversible and requires a second confirmation after the window. |
