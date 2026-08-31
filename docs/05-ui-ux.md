# Phase 5 — UI / UX

The design goal is **calm density**. Enterprise users need a lot of information on screen; the way to make that feel premium is disciplined typography, generous whitespace between groups, and almost no decoration — not smaller text and more panels.

---

## 1. Design principles

1. **The table is the product.** Most of a user's time is spent in a filtered list. Every hour spent on the `DataTable` component pays back more than any dashboard chart.
2. **Two clicks to anything.** Global search (`⌘K`) reaches any asset, person or page directly.
3. **Never lose work.** Forms open in drawers with unsaved-change guards. Filters live in the URL so back/refresh/share all work.
4. **Optimistic where safe, confirmed where not.** Editing a note is optimistic. Retiring an asset asks.
5. **Show the state, not a spinner.** Skeletons that match the eventual layout; content never jumps.
6. **Empty states do work.** An empty asset list offers "Import from spreadsheet" and "Add your first asset" — not a shrug.
7. **Colour carries meaning, not decoration.** One accent. Semantic colours reserved for state. State is never communicated by colour alone (accessibility, and it survives greyscale printing).
8. **Motion is functional.** 150–200 ms for drawers and toasts. Nothing else animates.

---

## 2. Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│ ▣ Acme Corp ▾   [⌘K Search anything...]        🔔 3   ● Priya R. ▾    │  56px
├──────────────┬─────────────────────────────────────────────────────────┤
│              │  Assets                              [Import] [+ Asset] │
│ ⌂ Dashboard  │  ─────────────────────────────────────────────────────  │
│              │  [All ▾] [Status ▾] [Category ▾] [Location ▾] [+Filter] │
│ ▤ Assets   ● │  ─────────────────────────────────────────────────────  │
│ ⇄ Assignments│  ☐ │ Tag     │ Name        │ State    │ Assignee │ ⋯    │
│ ⚑ Requests   │  ☐ │ LAP-042 │ MacBook Pro │ Deployed │ J. Okafor│ ⋯    │
│              │  ☐ │ LAP-043 │ ThinkPad X1 │ In stock │ —        │ ⋯    │
│ ○ People     │  ☐ │ MON-118 │ Dell U2723  │ Deployed │ S. Ahmed │ ⋯    │
│ ⌂ Locations  │                                                          │
│ ⊞ Departments│                                                          │
│              │  ─────────────────────────────────────────────────────  │
│ ⚒ Maintenance│  1–50 of 1,284                          [← Prev][Next →]│
│ ⌸ Licences   │                                                          │
│ ⛁ Vendors    │                                                          │
│              │                                                          │
│ ▦ Reports    │                                                          │
│ ⎘ Audit Log  │                                                          │
│ ⚙ Settings   │                                                          │
└──────────────┴─────────────────────────────────────────────────────────┘
     240px                        fluid, max 1600px
```

Navigation is grouped, not one long list: **Overview** (Dashboard) · **Inventory** (Assets, Assignments, Requests) · **Organisation** (People, Locations, Departments) · **Operations** (Maintenance, Licences, Vendors) · **Insights** (Reports, Audit Log) · **Settings**.

Items the user's role cannot access are hidden, not disabled — a disabled nav item just advertises something they can't have.

Breakpoints: `<768px` nav collapses to a bottom bar with the four primary destinations, tables become card lists · `768–1024px` nav collapses to icons · `>1024px` full layout.

---

## 3. The `DataTable` — build this properly, once

Every list screen uses it. Its capabilities are the product's capabilities.

- Server-side sort, filter, pagination — **the client never holds more than one page**
- Column visibility, reorder, and resize, persisted per user per view
- Custom fields appear as available columns automatically, from the field registry
- Row selection with an "all N matching this filter" option, feeding bulk actions
- Sticky header, sticky first column on mobile
- Row density toggle (comfortable / compact)
- Keyboard: `↑ ↓` navigate, `Enter` open, `Space` select, `/` focus filter
- Loading = skeleton rows matching the real column widths, never a layout shift
- Every state has a designed treatment: loading, empty, empty-after-filter, error, permission-denied

**Filter bar.** Common filters as inline dropdowns; `+ Filter` opens a builder driven by the same field registry, so a custom field is filterable the moment it is created. Active filters render as removable chips. The current filter set is the URL — shareable and bookmarkable. `Save view` turns it into a named, optionally shared view.

---

## 4. Key screens

### Dashboard
Reads pre-computed rollups, never the asset collection `[§11.2]`. Target < 150 ms.

Row 1 — five stat tiles with a trend delta: Total assets · Assigned · Available · In maintenance · Total value.
Row 2 — **Needs attention** (the most valuable panel in the app): warranties expiring in 30 days, licences expiring, maintenance due, unacknowledged assignments, people offboarding with assets outstanding. Each row is a link into a pre-filtered list.
Row 3 — assets by category (bar) and by location (bar). Not pie charts; humans compare lengths better than angles.
Row 4 — recent activity feed.

### Asset detail
Header: name, tag, state badge, condition badge, current assignee, primary action (`Assign` / `Return` — contextual to state), overflow menu.
Tabs: **Overview** (all fields, custom fields in their configured sections) · **Assignments** (chain of custody) · **Maintenance** · **Documents** · **Timeline** (every event, actor, before → after) · **Financials** (purchase, depreciation, book value).

The right rail holds the QR code, quick facts, and a "who to ask" link to the assignee's manager.

### Assign flow (drawer, not a page)
Search person → pick → optional location/due date/notes → optional "require acknowledgement" → confirm. Under 15 seconds for a technician. If the asset was assigned in the meantime, the drawer surfaces `409 ASSET_ALREADY_ASSIGNED` inline with the current holder and an offer to transfer instead — rather than a generic error toast.

### Import wizard (five steps, resumable)
`Upload → Map columns → Validate → Review → Commit`

Column mapping auto-matches on header similarity and remembers the tenant's last mapping. Validation is a dry run: a summary (`1,180 ready · 43 need attention · 12 duplicates`), a filterable error table showing the offending cell in context, and a downloadable corrected-file template. Duplicate handling is an explicit choice: skip / update / create anyway. Commit runs as a background job with live progress; the user can leave the page and gets a notification when it finishes.

**This wizard is the sales demo.** It deserves more design time than the dashboard.

### Offboarding
Triggered from a person's record. Shows everything they hold, generates a return checklist, tracks each item individually, and blocks completion until every item is returned, written off, or explicitly transferred. Deactivation without resolving assets requires an Owner override with a reason — recorded in the audit log.

### Settings
Sections: Organisation · Members & Roles · Asset Types · Categories · **Custom Fields** · Lifecycle Workflows · Locations · Departments · Cost Centres · Notifications · Billing & Usage · Integrations · Data (import/export/retention).

The custom-field editor is the highest-leverage settings screen: create, reorder by drag, group into sections, live preview of the resulting form, and an honest archive dialog that explains that existing values are retained and hidden, not deleted.

---

## 5. Component inventory (build order)

**Primitives** — Button, Input, Select, Combobox, DatePicker, Checkbox, Radio, Switch, Textarea, Badge, Avatar, Tooltip, Dropdown, Tabs, Card, Alert, Skeleton, Spinner, EmptyState.

**Composed** — DataTable, FilterBar, SearchCommand (`⌘K`), Drawer, Modal, ConfirmDialog, Toast, Pagination, StatTile, Timeline, FileUpload, **FieldRenderer**, PersonPicker, AssetPicker, StateBadge, PermissionGate.

**`FieldRenderer` is the keystone.** It renders any custom field type from its definition — the asset form, the person form, the import mapper, and the filter builder are all generated from the same registry. Nothing about a custom asset type is hand-written.

---

## 6. Accessibility (WCAG 2.1 AA, treated as a requirement)

Semantic HTML first; ARIA only where semantics run out. Full keyboard operability including the data table and drawers. Visible focus rings — never `outline: none` without a replacement. Focus trapped in modals and restored on close. 4.5:1 contrast minimum. Form errors linked with `aria-describedby` and announced. Async results announced via a live region. Respect `prefers-reduced-motion`. Never colour alone for state — badges carry a label and an icon.

Enterprise buyers increasingly require a VPAT. Building this in costs little; retrofitting it costs a quarter.

---

## 7. Performance budget

| Metric | Target |
|---|---|
| Initial JS (gzipped) | < 200 KB |
| LCP (dashboard, p75) | < 1.5 s |
| INP | < 200 ms |
| Table render, 50 rows | < 100 ms |
| Search-as-you-type | 250 ms debounce, cancel in flight |

Route-level code splitting per feature · virtualised rows above 100 · TanStack Query caching with sensible `staleTime` · prefetch on row hover · no chart library on the initial bundle.
