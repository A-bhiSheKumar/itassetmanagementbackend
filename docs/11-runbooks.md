# Runbooks

For the incidents this system can actually have, given how it is built. Each one starts with
how you would notice, because the hardest part of an incident is usually recognising which one
you are in.

Every log line carries `requestId`, `tenantId` and `userId`. A customer who quotes a request
id from an error response can be traced to the exact request:

```
grep '"requestId":"01M1A0JSB7DTH7GQRE2X6N5W4G"' <logs>
```

---

## 1. "A customer says they can see another customer's data"

**Drop everything else.** This is the one failure that ends the business.

**First, establish whether it is true.** Far more often it is a user who belongs to two
organisations and is looking at the wrong one, which the tenant switcher makes easy to do.
Ask which organisation name is shown in the sidebar.

If it is real:

1. Capture the `requestId` from the response and pull that request's logs. They carry the
   `tenantId` the request was scoped to.
2. Do not restart anything. The evidence is in memory and in the audit log.
3. Suspend the affected tenants (`POST /platform/tenants/:id/suspend`) — reads and exports
   still work, writes stop.
4. Query `auditLogs` for the actor across the window. Actor references survive even if the
   user has since been deleted.
5. Only then look for the cause. The plausible ones, in order:
   - A query using `withoutTenantScope()` outside `modules/platform/` — `grep -rn
     "withoutTenantScope" src/` — it is lint-restricted, so this means a rule was disabled.
   - A model missing from the scoping plugin — run `tests/security/modelScoping.test.ts`.
   - A route added without an isolation test — run `tests/security/tenantIsolation.test.ts`;
     it is generated, so a new route cannot avoid it.

**What makes this unlikely:** a query with no tenant in context throws rather than returning
everything, and the isolation suite is generated from the route table rather than hand-written.

---

## 2. "The API is up but every request 500s"

Check `/health/ready` first. It separates "the process is alive" from "it can serve".

| `/health/ready` says | Meaning | Do |
|---|---|---|
| `503`, `database: false` | Mongo unreachable | Check Atlas status and the connection count. The pool is 20 per replica; Atlas tiers cap total connections |
| `200` but requests fail | Application-level | Read the logs — every unexpected error is logged with its stack |

**If the logs show `MissingTenantScopeError`:** something is running a query outside a request
context. Almost always a new background job that forgot `runAsSystem()`.

**If the logs show `Transaction failed` or `That took too long to save`:** contention or a slow
primary. `withTransaction` has a 10-second deadline, so requests fail fast rather than hanging.
Check Atlas for a stepdown or an election.

---

## 3. "Everything is slow"

Work outward from the data:

1. **Atlas slow-query log.** Anything appearing there that is not the nightly rollup is the
   suspect.
2. **Is an index missing?** Run `npm test -- queryPlans`. It fails on a collection scan.
   Indexes build in the background and a malformed one is only reported on the model's `index`
   event — which is logged as `INDEX BUILD FAILED`. Grep for it.
3. **Is it one tenant?** Group request durations by `tenantId`. The per-tenant rate limit
   exists for exactly this, but it is currently in-memory and therefore per-replica (see
   [10-production-readiness.md](10-production-readiness.md) §3).
4. **Is it the dashboard?** It reads a daily rollup, so it should be tens of milliseconds
   regardless of estate size. If it is slow, the rollup is missing and it is recomputing on
   every load — check the `scheduled` queue.

Baselines at 100,000 assets are in [10-production-readiness.md](10-production-readiness.md) §4.
Anything an order of magnitude above those is a regression, not load.

---

## 4. "Background jobs have stopped"

Symptoms: the dashboard goes stale, warranty notices stop, imports sit at `committing`.

1. **Is a worker running?** The API is a producer only — it never consumes. A deployment that
   scaled the API but not the worker leaves the queue filling with nothing draining.
2. **Is Redis reachable?** In production an unreachable Redis is a fatal boot error, so a
   worker that will not start is a strong signal.
3. **Check queue depth:**
   ```
   redis-cli llen bull:imports:wait
   redis-cli zcard bull:scheduled:delayed
   redis-cli zcard bull:imports:failed
   ```
4. **Dead-lettered jobs** are logged as `Job dead-lettered` after five attempts. They need a
   human — that is the point of the limit.

**Events are recoverable.** Anything a request could not deliver inline stays `pending` in the
outbox and the worker drains it every five seconds. Nothing is lost by a worker being down for
a while; it just arrives late.

---

## 5. "An import is stuck"

1. `GET /api/v1/imports/:id` — `status` and `progress` are the truth.
2. `status: 'committing'` and `progress` not moving: check the worker and the `imports` queue.
3. `status: 'failed'`: the `error` field carries the reason.

**Re-running a commit is safe.** Rows are keyed by `(importJobId, rowHash)` with a unique
index, and only rows still awaiting a commit are picked up. A run interrupted at row 3,000
resumes rather than duplicating the first 2,999.

**Two imports for the same tenant serialise** behind a lock, so a second one appearing to
"hang" may simply be waiting. Different tenants run in parallel.

---

## 6. "A customer wants their data deleted"

1. `POST /platform/tenants/:id/request-deletion` sets `deletionScheduledAt` to +30 days. The
   data stays intact and read-only, and the request is cancellable throughout.
2. Offer an export first — it works on every plan, including a lapsed one.
3. After the window, the purge removes documents by `tenantId` and objects by the
   `t/{tenantId}/` storage prefix. A tombstone is retained for legal and billing.

**Erasing one person** rather than a tenant: PII fields are nulled and the record tombstoned.
Assignment and audit records survive because they hold references, not copied names, and render
as "Deleted user". History stays intact; the individual does not.

**Note:** event summaries do embed names, because that is what makes a timeline readable. A
full erasure needs those redacted too. That is specified and not yet built.

---

## 7. Deploying

1. `npm run build` on both.
2. Migrate first if the release adds an index — index builds on a large collection take time
   and should not be racing a rollout.
3. Deploy the worker before the API when the release adds a job type, so a queued job always
   has a consumer.
4. Health checks: `/health/live` for restarts, `/health/ready` for load-balancer membership.
   Conflating them makes a database blip restart every replica at once.
5. Shutdown drains in-flight requests and jobs, with a 15-second (API) / 20-second (worker)
   force-exit. Give the orchestrator at least that long before SIGKILL.

**Rolling back:** the application is stateless, so rolling back the image is safe. Rolling back
a *schema* is not — additive changes only, and nothing that removes a field the previous
release still writes.

---

## 8. What to check first, by symptom

| Symptom | Look at |
|---|---|
| One customer complains, others fine | `tenantId` in the logs; their subscription status |
| Everyone complains at once | `/health/ready`, then Atlas |
| Writes fail, reads work | Subscription state (`402`), or a Mongo primary election |
| `401` after a role change | Expected — `permVersion` invalidates the token; the client refreshes |
| `409` on assign | Expected — the asset is already assigned. The response names the holder |
| `402` on create | Plan limit. `GET /tenant/usage` shows exactly where they are |
| Import rejects everything | Almost always the date order. It is declared, never guessed |
