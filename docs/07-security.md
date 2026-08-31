# Security

Security posture is set by what is **structurally impossible**, not by what is documented as forbidden. Every control below is stated as the mechanism that enforces it.

---

## 1. Threat model — what actually goes wrong in multi-tenant SaaS

Ranked by likelihood × impact for a product of this shape:

| # | Threat | Realistic vector | Primary defence |
|---|---|---|---|
| T1 | **Cross-tenant data exposure** | One query written without a tenant filter | Query layer *throws* without tenant context; per-route isolation test suite in CI |
| T2 | **IDOR** | `GET /assets/:id` with a guessed or leaked id | Tenant filter applied in the repository; **404 not 403** for foreign resources |
| T3 | **Privilege escalation** | Member edits their own role, or an Admin grants themselves Owner | Server-side grant check: cannot grant what you don't hold; strict DTOs; role changes audited |
| T4 | **Mass assignment** | `{"role":"owner","tenantId":"..."}` posted to a profile update | Zod **strict** schemas reject unknown keys; models are never hydrated from raw bodies |
| T5 | **NoSQL injection** | `{"email":{"$ne":null}}` in a login body | Type-enforcing validation at the boundary; operator keys rejected |
| T6 | **Stolen refresh token** | XSS or a leaked device | Rotation with reuse detection → family revocation + security alert |
| T7 | **Malicious file upload** | Renamed executable, SVG with script, zip bomb | Magic-byte verification, extension allowlist, AV scan, private bucket, presigned time-boxed reads |
| T8 | **CSV formula injection** | Asset name `=cmd\|'/c calc'!A1` exported and opened in Excel | Prefix dangerous leading characters on export |
| T9 | **Account takeover** | Credential stuffing against login | Argon2id, per-account and per-IP rate limits, progressive lockout, breach-password check, MFA (v1.2) |
| T10 | **Insider / support abuse** | Super Admin browsing customer data | No default access; impersonation only, time-boxed, reason-required, audited, per-tenant blockable |
| T11 | **Noisy-neighbour DoS** | One tenant saturates the API or the queue | Per-tenant rate limits and queue concurrency caps |
| T12 | **Audit tampering** | Admin deletes evidence of their own action | No update/delete route exists at any role; optional hash chain for tamper evidence |

---

## 2. Tenant isolation — the control that matters most

Five independent layers, detailed in [02-architecture.md](02-architecture.md) §3.2:

1. Ambient `AsyncLocalStorage` context — no parameter threading, nothing to forget
2. Mandatory Mongoose plugin — injects the filter, **throws** when context is absent
3. `withoutTenantScope(reason, fn)` — the only escape hatch: greppable, audited, lint-restricted to `modules/platform/`
4. `tenantId` never read from a request — session only
5. **Automated per-route isolation tests** — a route without one fails CI

Layer 5 is what makes the other four durable. A control that depends on every future developer remembering it is not a control; a test that fails the build is.

---

## 3. Authentication

- **Argon2id** password hashing (memory-hard; bcrypt is acceptable but weaker against GPU attack). Never SHA-family, never unsalted.
- Minimum 12 characters, checked against the HaveIBeenPwned k-anonymity range API. Composition rules (one symbol, one digit) are deliberately not used — they produce predictable passwords.
- Access tokens 15 min; refresh tokens 30 days, rotating, `httpOnly` + `Secure` + `SameSite=Lax`, path-scoped, hashed at rest.
- Reuse detection revokes the whole token family and raises a security event.
- `tokenVersion` (user) and `permVersion` (membership) give instant global revocation without a blocklist.
- Login rate limits: 5 attempts / 15 min **per account and per IP**, progressive backoff. Timing-safe comparison and identical responses for unknown-email vs. wrong-password, so login is not a user-enumeration oracle.
- Email verification required before tenant creation. Password reset tokens are single-use, 1-hour, and invalidate all sessions on use.
- MFA (TOTP + recovery codes) in v1.2; enforceable tenant-wide on Business+.

---

## 4. Authorization

- Every route declares `requirePermission(...)`. A **test enumerates the route table and fails on any route without an explicit permission or an explicit `@public` marker** — so a new endpoint cannot ship unguarded by omission.
- Record-level policies handle scoping (department/location) at the service layer, and the same scope filter is applied to list queries in the repository — so a scoped user's list and detail access can never disagree.
- Privilege-escalation guard and last-owner guard are unit-tested invariants, not conventions.
- Frontend permission gating is convenience only; the server checks unconditionally.

---

## 5. Input & output

**In:** Zod strict schemas at every boundary — body, query, params. Unknown keys rejected, not stripped. Types enforced, so `$ne`/`$gt` objects never reach the driver. Size limits: 1 MB JSON body, 200 items per bulk operation, `limit` capped at 100. Depth-limited object parsing.

**Out:** explicit DTO mappers. A Mongoose document is never serialised directly — that is how `passwordHash`, `tokenHash` and internal flags leak. Error responses never contain stack traces or driver messages; a raw `E11000` string discloses collection and index names.

---

## 6. Files

Private bucket, no public read, ever. Presigned PUT (5 min) → server verifies existence, real size, and **magic bytes** → mark ready. Extension + content-type allowlist. SVG rejected, or served `Content-Disposition: attachment` under a sandboxing CSP. EXIF stripped from images. ClamAV scan before a file becomes downloadable on Business+. Keys prefixed `t/{tenantId}/` so a bucket policy can enforce isolation as defence in depth and tenant purge is a prefix delete. Download is a presigned GET issued **after** an authorization check — never a stable URL.

---

## 7. Transport & headers

TLS 1.2+ only, HSTS with preload. Helmet with a real CSP (`default-src 'self'`, no `unsafe-inline`, nonce-based scripts), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, restrictive `Permissions-Policy`.

CORS: explicit origin allowlist (no `*`, no reflected origin), credentials enabled, preflight cached. Cookie-based auth is CSRF-protected by `SameSite=Lax` plus a double-submit token on state-changing requests.

---

## 8. Data protection

Encryption in transit (TLS) and at rest (Atlas + S3 SSE). Field-level encryption is available for fields flagged `isPii` on Enterprise. Logs redact tokens, passwords, and `isPii` fields automatically — the redaction list is derived from the field registry, so a new PII custom field is protected without a code change.

Secrets come from a secret manager (AWS Secrets Manager / Doppler), never from a `.env` file in an image, never from the repository. Rotation procedure documented and rehearsed. Backups encrypted, **restore tested quarterly** — an untested backup is a hope, not a backup.

GDPR: data export, right to erasure (§5 of [06-edge-cases.md](06-edge-cases.md)), documented retention, DPA-ready sub-processor list, and a data-residency path via the connection resolver.

---

## 9. Auditing

Every sensitive action is audited: logins (success **and** failure), permission and role changes, member add/remove, asset create/update/delete/assign/transfer, exports (who exported what, when — a common exfiltration path), configuration changes, subscription changes, impersonation start/end, and every denied authorization attempt.

Denied attempts are indexed separately (`{tenantId, outcome:'denied', occurredAt:-1}`) because a burst of them is the clearest available signal of an attack in progress.

Append-only: no update or delete route exists at any role, including Owner. Optional per-tenant hash chain (`prevHash` → `hash`) makes tampering detectable rather than merely prohibited.

---

## 10. Dependencies & pipeline

`npm audit` + Dependabot/Renovate in CI, with a policy on how fast a critical advisory must be patched. Lockfiles committed. Provenance-checked packages where available. SAST (CodeQL) and secret scanning on every PR. No production access from developer laptops without MFA and a bastion. Least-privilege IAM. Staging never holds real customer data.

---

## 11. Pre-launch security checklist

- [ ] Isolation test suite covers **every** registered route
- [ ] Route table test: no route without an explicit permission or `@public` marker
- [ ] Privilege-escalation and last-owner invariants unit-tested
- [ ] Strict Zod schemas on every endpoint; a mass-assignment test asserts extra keys are rejected
- [ ] Magic-byte validation verified with a renamed executable
- [ ] CSV formula-injection test on export
- [ ] Refresh-token reuse detection verified end to end
- [ ] Rate limits verified under load, including per-tenant isolation
- [ ] CSP with no `unsafe-inline`; verified in a browser, not just in the header
- [ ] No secrets in the repository (history scanned) or in the built image
- [ ] Backup restore rehearsed against a fresh environment
- [ ] Dependency audit clean at critical and high
- [ ] External penetration test before the first enterprise customer
