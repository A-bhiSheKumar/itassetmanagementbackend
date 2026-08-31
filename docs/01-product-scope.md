# Phase 1 — Product Definition

## 1. Personas

| Persona | Who they are | What they need | What they will not tolerate |
|---|---|---|---|
| **Platform Operator** (Super Admin) | Us. Runs the SaaS. | Tenant list, subscription state, usage, health, support impersonation, platform audit | Being unable to diagnose a customer issue without asking for a screenshot |
| **IT Manager** (Company Admin) | Owns the asset estate at a customer. Primary buyer. | Import their existing spreadsheet in under 30 minutes, see everything, assign quickly, answer the CFO's questions | A tool slower than the spreadsheet it replaces |
| **IT Technician** (Company Admin, scoped) | Does the day-to-day: images laptops, hands them out, takes them back | Fast check-out/check-in, scan-to-open, bulk actions, minimal typing | Ten-field forms to hand someone a mouse |
| **Finance / Procurement** | Cares about money, not hardware | Spend by cost centre, depreciation, warranty and renewal pipeline, vendor spend, exportable everything | Numbers that don't reconcile with their ledger |
| **Employee** (Member) | Has a laptop. Logs in twice a year. | See what they hold, acknowledge receipt, report a problem, request something | Being asked to learn an asset system |
| **Auditor / Compliance** | Internal or external, periodic | Complete, tamper-evident history; who had what, when; evidence of access control | "The record was updated so we don't know what it was before" |

**Design consequence:** the IT Technician and the Employee are the highest-volume users but the IT Manager is the buyer. Build for the Manager's evaluation, optimise for the Technician's daily loop, and make the Employee's surface almost zero-learning.

---

## 2. Core workflows (the ones that must be excellent)

These are the flows the product lives or dies on. Everything else is supporting.

### W1 — Onboarding: spreadsheet to live system
`Sign up → verify email → create org → pick plan → invite team → import assets CSV → map columns → fix errors → commit → dashboard populated`

This is the whole sales cycle. If it takes more than 30 minutes the deal is lost. Non-negotiables: column auto-mapping, row-level errors with a downloadable fix file, re-upload without starting over, and a dry-run preview before anything is written.

### W2 — Assign an asset
`Find asset (search/scan) → assign to person → set location/date → optional acknowledgement request → asset timeline updated → person notified`

Must be under 15 seconds for a technician who knows what they're doing. Must be impossible to double-assign.

### W3 — Return / transfer
`Find active assignment → check in → record condition → optionally reassign in the same flow → history preserved on both sides`

Transfer is check-in + check-out as one atomic operation, not two separate actions the user has to remember to do in order.

### W4 — Offboarding
`Mark person as leaving → system lists everything they hold → generate return checklist → track each item → confirm all returned → deactivate`

The brief asks "what happens when an employee is deactivated while holding assets?" — this workflow *is* the answer. Deactivation does not silently orphan assignments; it opens an offboarding record.

### W5 — Answer a question
`Filter/search → refine → save the view → export or share`

The IT Manager's whole job. Filtering must be fast on 100k assets, must cover custom fields, and saved views must be shareable with the team.

### W6 — Prove what happened
`Open asset → timeline → every change with actor, before, after, timestamp`

Sold to the Manager, used by the Auditor, and the reason customers trust the system over a spreadsheet.

---

## 3. Feature prioritisation

Scored on **value to first customers** vs. **cost to build later**. The cut line is drawn where a paying customer can run their estate end-to-end.

### MVP (v1) — the sellable core

| Module | In scope for v1 | Explicitly out of v1 |
|---|---|---|
| **Auth** | Email+password, email verification, invitations, refresh-token rotation, password reset | SSO/SAML, SCIM, MFA (v1.2), magic links |
| **Tenancy** | Signup, org creation, tenant context enforcement, suspend/reactivate | Per-tenant database, data residency routing |
| **Users & roles** | User/Membership/Person split, 3 system roles, full permission framework behind them | Custom role builder UI (framework exists, UI is v1.2) |
| **People** | CRUD, CSV import, departments, locations, manager, deactivate + offboarding flow | HRIS sync, org chart visualisation |
| **Asset types & fields** | Custom asset types, custom categories, **custom fields (all types)**, field archival | Conditional/dependent fields, computed fields |
| **Assets** | CRUD, list with filter/sort/cursor pagination, asset tag auto-generation, QR codes, attachments | Kits/components, consumables, cloning |
| **Assignment** | Assign, return, transfer, acknowledgement, DB-enforced single active assignment | Reservations, due dates, overdue tracking, check-out pools |
| **Lifecycle** | Configurable states + transitions per asset type, default template seeded | Multi-step approvals inside transitions |
| **History** | Asset timeline + separate immutable audit log, both event-sourced from the outbox | Diff replay / point-in-time reconstruction UI |
| **Dashboard** | Core counts, by-category/location/status, warranty pipeline, recent activity | Custom dashboard builder, saved widgets |
| **Import/Export** | Async, staged, dry-run, row errors, CSV + XLSX, for assets and people | Scheduled imports, API-driven bulk load |
| **Documents** | S3 presigned upload/download, tenant-scoped, type + size validation | Versioning, e-signature, OCR |
| **Warranty** | Dates, provider, expiry alerts on dashboard + email | Auto-lookup by serial |
| **Notifications** | In-app + email, central dispatcher, per-user preferences | SMS, Slack/Teams, digest scheduling |
| **Billing** | Plans, entitlement enforcement (users/assets/storage), usage counters, read-only on expiry | Payment provider integration — manual invoicing for the first cohort |

**MVP definition of done:** a 200-person company can import their estate, assign everything, offboard a leaver, survive an audit question, and hit a plan limit — without us touching the database.

### v1.1 — the obvious next asks (≈6 weeks after v1)
Vendors · Maintenance & repair history · Software products & licences with seat allocation · Saved views · Advanced/scheduled reports · Bulk edit · Depreciation & book value

### v1.2 — the enterprise unlock
Custom role builder · Asset requests & approvals · Purchase orders & procurement · Webhooks + API keys + public API · MFA · Contracts · Check-out pools with due dates

### v2 — moat
SSO (SAML/OIDC) + SCIM · MDM/discovery integrations with field provenance · Mobile scanning app with offline queue · Stocktake/audit sessions · Consumables & stock · Kits and parent/child assets · Multi-currency reporting

### Deliberately not doing (and why)
| Not doing | Reason |
|---|---|
| Microservices | Nothing about this workload needs independent scaling. A modular monolith with clean seams is faster to build and easier to operate. Revisit at ~50 engineers, not before. |
| Per-tenant database in v1 | Operationally expensive (migrations × N). The connection resolver is designed now so it's a config change when an enterprise deal requires it. |
| Real-time collaborative editing | Nobody co-edits an asset record. Optimistic concurrency with version checks is sufficient. |
| Full ITSM / ticketing | Different product. Integrate with Jira/ServiceNow instead of competing with them. |
| AI features in v1 | No credible use case yet that beats good search and good filters. Revisit once we have real usage data. |
| GraphQL | REST with consistent conventions is enough, and easier to cache, rate-limit and document. |

---

## 4. Roles and permission surface (v1)

Three system roles, built on a granular permission framework so custom roles are a UI feature later, not a re-architecture.

| Role | Scope | Summary |
|---|---|---|
| **Super Admin** | Platform | Tenants, plans, subscriptions, platform audit, impersonation. **No default access to tenant business data** — impersonation is the only path, and it is logged and blockable. |
| **Owner** | Tenant | Everything in the tenant, including billing, deleting the tenant, and transferring ownership. Exactly one required at all times. |
| **Admin** | Tenant | Everything except billing, tenant deletion, and ownership transfer. |
| **Manager** | Tenant, scoped | Full asset/assignment rights limited to their department or location. The scoping mechanism is built in v1 even though the UI exposes it minimally. |
| **Member** | Self | View own assets, acknowledge assignments, report issues, request assets, update permitted profile fields. |

Permissions are `resource:action` strings (`asset:create`, `asset:assign`, `person:deactivate`, `billing:manage`, …) with an optional scope (`all` / `department` / `location` / `own`). See [02-architecture.md](02-architecture.md) §5.

**Escalation rule, enforced server-side:** an actor can never grant a permission they do not themselves hold, and can never modify a role that grants more than their own set.

---

## 5. Plan structure (starting point)

| | Starter | Professional | Business | Enterprise |
|---|---|---|---|---|
| Users (seats) | 5 | 25 | 100 | Unlimited |
| People (asset holders) | 100 | 500 | 5,000 | Unlimited |
| Assets | 250 | 2,500 | 25,000 | Unlimited |
| Storage | 1 GB | 10 GB | 100 GB | Custom |
| Custom fields | 5 | 25 | Unlimited | Unlimited |
| Custom roles | — | — | ✓ | ✓ |
| Audit retention | 90 days | 1 year | 3 years | 7 years |
| API + webhooks | — | — | ✓ | ✓ |
| SSO / SCIM | — | — | — | ✓ |
| Support impersonation opt-out | — | — | — | ✓ |

**Note the separation of "users" from "people".** Seats are what we charge for; asset holders are not seats. A 5,000-person company with 6 IT staff pays for 6 seats. This is both fairer and a competitive advantage — and it is only possible because of decision D2.

Entitlements are stored as a data map on the plan, not as `if (plan === 'pro')` branches. Adding a plan or granting a one-off exception to a customer is a data change.
