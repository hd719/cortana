# Implementation Plan - Mission Control Autonomy Ops

**Document Status:** Complete

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | Huragok |
| Epic | OpenClaw Autonomy: Mission Control Autonomy Ops |
| Tech Spec | [Tech Spec](../techspec/techspec-mission-control-autonomy-ops.md) |
| PRD | [PRD](../prd/prd-mission-control-autonomy-ops.md) |

---

## Dependency Map

**Implementation status:** Complete. The autonomy artifact writer, Mission Control reader library, read API, refresh API, `/autonomy` operator page, sidebar nav entry, periodic artifact cron writer, and focused API/library/sidebar tests are implemented.

| Vertical | Dependencies | Can Start? |
|----------|--------------|------------|
| V1 - Autonomy artifact | None | Complete |
| V2 - Mission Control API | V1 schema | Complete |
| V3 - Mission Control page | V2 | Complete |
| V4 - Runtime refresh and docs | V1, V2, V3 | Complete |

---

## Recommended Execution Order

```text
Week 1: cortana JSON artifact writer, per-source freshness schema, and schema tests
Week 2: Mission Control read API, fixtures, page, sidebar nav
Week 3: Refresh endpoint, cron writer, smoke validation, docs
```

---

## Sprint 1 - Read Model

### Vertical 1 - Autonomy artifact

**cortana: write one stable Autonomy Ops JSON payload for Mission Control.**

*Dependencies: None*

**Implementation status:** Complete. V1 artifact writer is implemented with a guarded/import-safe autonomy summary, versioned cached JSON schema, source freshness degradation, atomic writes, and focused tests.

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana/tools/monitoring/write-autonomy-ops-artifact.ts`.
- Sub-task 2: Refactor `/Users/hd/Developer/cortana/tools/monitoring/autonomy-ops.ts` only as needed to export a stable schema.
- Sub-task 3: Add `/Users/hd/Developer/cortana/tests/monitoring/autonomy-ops-artifact.test.ts` with `live`, `watch`, `attention`, stale-source, missing-source, and fresh-artifact/stale-source fixtures.

#### Testing

- Artifact includes `schemaVersion`, `generatedAt`, `freshUntil`, `operatorState`, sections, counts, and per-source freshness/confidence fields.
- Missing source degrades confidence but does not fabricate green status.
- A freshly generated artifact with a stale required source cannot produce `operatorState=live`.
- Writer uses atomic write.

---

## Sprint 2 - Mission Control Read Surface

### Vertical 2 - API boundary

**cortana-external: expose a read-only API backed by the cached artifact.**

*Dependencies: V1 schema*

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana-external/apps/mission-control/lib/autonomy-ops.ts`.
- Sub-task 2: Create `/Users/hd/Developer/cortana-external/apps/mission-control/app/api/autonomy-ops/route.ts`.
- Sub-task 3: Add `/Users/hd/Developer/cortana-external/apps/mission-control/lib/autonomy-ops.test.ts`.

#### Testing

- Fresh artifact returns `{ ok: true, stale: false }`.
- Stale artifact returns data with `stale: true`.
- Missing or invalid artifact returns an error shape without crashing.
- Source entries missing required freshness metadata are treated as missing/stale and prevent live posture.

### Vertical 3 - Operator page

**cortana-external: add `/autonomy` as the top-level autonomy posture page.**

*Dependencies: V2*

#### Jira

- Sub-task 1: Create `/Users/hd/Developer/cortana-external/apps/mission-control/app/autonomy/page.tsx`.
- Sub-task 2: Render the page from server-side read models so page load remains read-only and does not run remediation.
- Sub-task 3: Update `/Users/hd/Developer/cortana-external/apps/mission-control/components/sidebar.tsx` with a top-level `Autonomy` link.

#### Important Planning Notes

- Keep v1 read-only.
- Use compact operator-first layout: top-level state, blockers, human-required items, stale signals, recent auto-fixes.
- Page load must never run remediation.

#### Testing

- UI fixtures render `live`, `watch`, and `attention`.
- Stale cache is visibly labeled.
- Stale required sources are visibly listed even when the artifact file itself is fresh.
- Sidebar link appears in desktop and mobile nav.

---

## Sprint 3 - Refresh And Operations

### Vertical 4 - Refresh, cron, and docs

**cross-repo: make the read model fresh without shelling out on page load.**

*Dependencies: V1, V2, V3*

#### Jira

- Sub-task 1: Add `/Users/hd/Developer/cortana-external/apps/mission-control/app/api/autonomy-ops/refresh/route.ts` with read-only command allowlist and timeout.
- Sub-task 2: Update `/Users/hd/Developer/cortana/config/cron/jobs.json` to write the artifact periodically.
- Sub-task 3: Update `/Users/hd/Developer/cortana-external/apps/mission-control/README.md` and `/Users/hd/Developer/cortana/docs/source/runbook/openclaw-doctor-inspector-runbook.md`.

#### Testing

- Refresh endpoint runs only the artifact writer.
- Refresh failure returns stale data when available.
- Mission Control restart smoke confirms `/autonomy` loads locally.

---

## Dependency Notes

### V1 before V2

Mission Control should consume a stable artifact schema, not parse arbitrary CLI text.

### V2 before V3

The page should render from API fixtures so UI behavior is testable before live runtime data is involved.

### V3 before V4

Refresh and cron wiring are easier to validate after the static read path works.

---

## Scope Boundaries

### In Scope

- Versioned autonomy read model.
- Read-only Mission Control API and page.
- Explicit refresh endpoint.
- Top-level navigation.

### External Dependencies

- Local file access to `~/.openclaw/reports/autonomy-ops/latest.json`.
- Existing Mission Control auth/access model.
- Periodic cron writer.

### Integration Points

- `/Users/hd/Developer/cortana/tools/monitoring/autonomy-ops.ts`
- `/Users/hd/Developer/cortana-external/apps/mission-control/components/sidebar.tsx`
- `/Users/hd/Developer/cortana-external/apps/mission-control/app/api`

---

## Realistic Delivery Notes

The smallest credible build is a cached artifact plus a read-only page. Mutating controls should wait until stale-vs-active and human-required data are trusted.

- **Biggest risks:** cross-repo schema drift, accidental remediation from refresh, stale dashboard confidence, hiding stale source data inside a freshly written artifact.
- **Assumptions:** Mission Control can read local artifacts, operator access stays private, v1 is read-only.
