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

## 3. Rate limiting

Three dimensions are enforced: per IP, per user, per tenant. The per-tenant one is the
important one, because it is what stops a single noisy customer degrading everyone else.

**Counters are shared across replicas** (`RedisRateLimitStore`), so the number in the config
is the number that is enforced — previously, with in-memory counters and N replicas, the
effective limit was N times what it said and it drifted every time the deployment scaled.
`INCR` and `PEXPIRE` run in one Lua script: two round trips would race, and a crash between
them would leave a key with no expiry, locking that client out permanently.

Two deliberate trades:

- **Fixed window, not sliding.** A fixed window permits up to 2× the limit across a boundary.
  It bounds sustained load, which is what actually threatens the service, and the limits where
  a burst would matter — login, invitation — are small enough that 2× is still small.
- **Fails open, loudly.** If Redis is unreachable the local per-replica counter still applies
  and one error line is logged. Rate limiting protects availability; it must not become the
  thing that removes it.

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
- **Reconciliation job** — built and running nightly, before the rollup. It checks
  `currentAssignment` against the assignment collection in both directions, because they fail
  differently: an active assignment the asset does not point at makes the asset look free, and
  someone assigns it to a second person; an asset pointing at a returned assignment makes it
  look held, and nobody can assign it at all. It also recomputes the usage counters that drive
  plan enforcement. Repairs when run as a job, and every repair is logged and counted — a
  rising count means something is writing around the assignment service, and the repair only
  treats the symptom.
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
| Error tracking | Done — Sentry-shaped reporter behind an interface, so the vendor is a config change |
| Metrics endpoint | Done — `/health/metrics` in Prometheus text format; `/health/summary` for humans |
| Alerting on error rate, queue depth, DB latency | **Not built.** The metrics exist; nothing scrapes them or pages anyone |
| CI pipeline | Done — lint, typecheck, tests, `npm audit` and the load test on every push |

Metric labels carry the route **pattern**, never the URL. This is not cosmetic: `req.baseUrl`
is the matched URL prefix, so a router mounted at `/assets/:id` naively produces one series per
asset. Unbounded label cardinality is the standard way to take down a metrics backend, and it
is invisible until the series count explodes — a test asserts no label ever contains an id.

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

**Ready:** most of the operational envelope. CI runs lint, typecheck, the full suite, `npm
audit` and the load test on every push. Errors are reported and requests are measured. Rate
limits survive horizontal scaling. The denormalised assignment cache is reconciled nightly.

**Not ready**, and honestly so:

1. **No rehearsed backup restore.** No cluster exists yet, so there is nothing to restore from.
   An untested backup is a hope, not a backup. This is the one remaining item that blocks
   taking money, and it cannot be closed from a laptop.
2. **Nothing scrapes the metrics.** The endpoint is there and the numbers are right; no
   Prometheus polls it and no alert fires on error rate or queue depth. Until then a bad deploy
   is discovered by a customer.
3. **No way to change plan.** Enforcement is complete; billing was deferred to manual
   invoicing for the first cohort.
4. **Full GDPR erasure needs redaction.** Event summaries embed names for readability, so a
   deletion request needs those summaries redacted rather than only the source rows removed.

The shortest remaining path to a first paying customer: provision Atlas, turn backups on,
rehearse one restore, and point a scraper at `/health/metrics` with two alerts on it.
