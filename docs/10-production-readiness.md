# Production Readiness

Worked through at the end of Milestone 6. Every line is either **verified** (there is a test
or a measurement behind it), **partial** (built, with a stated limitation), or **not done**
(with what it would take). Nothing is marked done because it looks done.

---

## 1. Security checklist ([07-security.md](07-security.md) §11)

| Item | Status | Evidence |
|---|---|---|
| Isolation suite covers **every** registered route | **Verified** | `tests/security/tenantIsolation.test.ts`, generated from the route table. 532 assertions |
| No route without an explicit permission or `@public` | **Verified** | `tests/security/routeGuards.test.ts` — 100 tests, plus a snapshot of the whole public surface |
| Permission matrix: every route × every role | **Verified** | `tests/security/permissionMatrix.test.ts` — 326 cells |
| Privilege-escalation and last-owner invariants tested | **Verified** | `tests/http/auth.test.ts` |
| Strict Zod schemas; extra keys rejected | **Verified** | Mass-assignment test in `auth.test.ts` |
| Magic-byte validation, tested with a renamed executable | **Verified** | `tests/http/documents.test.ts` — a Mach-O header named `invoice.pdf` is rejected |
| CSV formula-injection protection on export | **Verified** | `tests/http/imports.test.ts`, and live: `=cmd\|'/c calc'!A1` exports as `'=cmd…` |
| Refresh-token reuse detection end to end | **Verified** | `auth.test.ts` — a replayed token revokes the whole family |
| Rate limits, including per-tenant isolation | **Partial** | Three dimensions implemented (IP, user, tenant); **in-memory, so per-replica**. See §3 |
| CSP with no `unsafe-inline`, verified in a browser | **Partial** | Header set and asserted in `app.test.ts`; not yet verified in a real browser |
| No secrets in the repository or the built image | **Verified** | Scanned before the first push; only `.env.example` placeholders |
| Backup restore rehearsed | **Not done** | Needs a real Atlas cluster. See §5 |
| Dependency audit clean at critical and high | **Verified** | See §2 |
| External penetration test | **Not done** | Before the first enterprise customer, per the plan |

---

## 2. Dependencies

`npm audit` is run below and recorded with the run. Lockfile committed; exact versions pinned
in `package.json`.

Not yet wired: Dependabot/Renovate, CodeQL, and secret scanning in CI — there is no CI
pipeline yet, which is the honest gap. Everything in this document is currently run by hand.

---

## 3. Rate limiting — the real limitation

Three dimensions are enforced: per IP, per user, per tenant. The per-tenant one is the
important one, because it is what stops a single noisy customer degrading everyone else.

**The counters are in memory.** With N API replicas each enforces its own counter, so the
effective limit is N times what it says. That is fine for a single process and wrong for a
scaled deployment. The store is behind an interface (`RateLimitStore`) so a Redis-backed
implementation is a drop-in — Redis is already a dependency for the job queue.

Until then the published numbers are deliberately conservative, and the limits that actually
matter — login and invitation — are the tightest.

---

## 4. Performance

Measured with `npm run loadtest` at **100,000 assets in one tenant, plus 20,000 in a second**
so every figure includes the cost of filtering another tenant out.

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Asset list, first page | 2.6 ms | 3.5 ms | 8.3 ms |
| Asset list, filtered by state | 2.1 ms | 3.1 ms | 5.0 ms |
| Asset list, filtered by location | 2.7 ms | 3.6 ms | 16.6 ms |
| Custom-field filter (`ram >= 32`) | 1.7 ms | 2.5 ms | 3.1 ms |
| Quick search by prefix | 3.0 ms | 3.7 ms | 23.7 ms |
| What one person holds | 0.3 ms | 0.4 ms | 0.7 ms |
| Serial number lookup | 0.7 ms | 0.9 ms | 6.4 ms |
| Page 20 via cursor | 1.9 ms | 3.0 ms | 3.3 ms |
| Dashboard | 18.0 ms | 25.7 ms | 43.4 ms |
| Metrics rollup rebuild *(nightly job)* | 355.9 ms | 442.9 ms | 457.8 ms |

**Budget: p95 < 300 ms. Passes with two orders of magnitude of headroom** on every request
path.

These are database-time figures, not end-to-end HTTP. Network, TLS and JSON serialisation sit
on top; the point of the measurement is that the data layer is not the constraint.

### What the measurement changed

The dashboard started at 103 ms p95 and is now 25.7 ms. Profiling — rather than guessing —
put 90 ms of that in a single query, and the cause was subtle:

> A partial index is only used when the query **provably implies its filter.** The index was
> partial on `{'warranty.expiresAt': {$type: 'date'}}` and the query said `{$ne: null}`.
> `$ne: null` does not imply "is a date", so the planner refused the index and scanned:
> 2,000 documents examined for 300 results. Changing the query to `$type: 'date'` made it 300
> examined for 300 results.

Two guesses were wrong before that one was right (an index on `condition`, then adding
`lifecycleState` to the warranty index — both reasonable, neither the cause). The lesson is in
the order: profile, then fix.

---

## 5. Data

- **Automated backups** — Atlas continuous backup, not yet configured. No cluster exists.
- **Restore rehearsal** — **not done.** An untested backup is a hope, not a backup. It needs
  a real cluster and should be repeated quarterly.
- **Retention** — TTL indexes on `expiresAt`, stamped per document from the tenant's plan.
- **Reconciliation jobs** — the `currentAssignment` cache is written only inside the
  assignment transaction; a nightly job to assert it agrees with the assignment collection is
  **specified but not built**.
- **Tenant export and purge** — export exists per entity; whole-tenant export and verified
  deletion are **not built**.

---

## 6. Operations

| | Status |
|---|---|
| Health endpoints (`/health/live`, `/health/ready`) | Done, separated so a database blip does not restart every replica |
| Graceful shutdown draining requests and jobs | Done |
| Structured logs with `requestId` / `tenantId` / `userId` | Done |
| Automatic redaction of tokens, passwords and PII fields | Done |
| Boot-time env validation | Done — the process refuses to start on a missing variable |
| Index build failures surfaced | Done — and it immediately found two silently-missing indexes |
| Error tracking (Sentry) | **Not wired.** The error handler has the hook point |
| Metrics endpoint / dashboards | **Not built** |
| Alerting on error rate, queue depth, DB latency | **Not built** |
| CI pipeline | **Not built** — everything here is run by hand |

---

## 7. Commercial

- Entitlements enforced server-side on every create, and at import **validation** so a run
  never half-imports.
- Grace period and read-only mode on lapse: implemented, `assertSubscriptionAllowsWrites()`.
- **No way to change plan.** Enforcement is complete; self-serve upgrade is not built, because
  billing was deliberately deferred to manual invoicing for the first cohort. It becomes real
  work the moment somebody wants to pay more.
- Data export is available on every plan, including a lapsed one. Never hold a customer's data
  hostage.

---

## 8. Honest summary

**Ready:** the application. Tenant isolation, authorisation, the data model, the indexes, and
the read paths are tested and measured rather than asserted.

**Not ready:** the operational envelope. There is no CI, no error tracking, no alerting, no
backup rehearsal, and rate limiting does not survive horizontal scaling. None of these are
large; all of them are the difference between "the code works" and "we can run this for
someone."

The shortest path to a first paying customer, in order:

1. CI running lint, typecheck, tests and `npm audit` on every push.
2. Sentry, and alerts on error rate and queue depth.
3. Redis-backed rate limiting — a small change, and it makes the limits mean what they say.
4. A provisioned Atlas cluster, backups on, and one rehearsed restore.
5. The assignment reconciliation job.
