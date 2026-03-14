# PRD: Trading Cron Base / Enrichment / Notify Decoupling

**Status:** Draft  
**Owner:** Cortana / OpenClaw trading workflow  
**Primary repos:** `cortana`, `cortana-external`  
**Intent:** Make the trading cron architecture reliable, fast, and operationally simple by separating production-critical compute from optional enrichments and final notification delivery.

---

## Summary

The current trading workflow has improved, but it still carries too much optional logic too close to the critical market-session path.

This PRD proposes a clean architecture with three explicit layers:

1. **Base compute**
2. **Optional enrichment**
3. **Notify**

The goal is simple:
- the base run should always produce the official latest artifact
- optional enrichments should never be allowed to invalidate the base run
- notifications should only read from the latest valid base artifact and merge enrichments only when they are fresh and compatible

This is an architecture PRD, not a feature PRD.

---

## Problem

Today, useful but non-essential logic can still behave like part of the critical path.

Examples:
- council deliberation
- Polymarket overlays
- experimental alpha annotations
- wrapper and subprocess launch failures
- stale artifact ambiguity

When those concerns are too close to the main market-session run, the result is:
- failed latest artifacts even though the core scan mostly worked
- stale or confusing notifier behavior
- harder diagnosis during market hours
- more operational drag than necessary

The system becomes an operations problem instead of a trading system.

---

## Core Thesis

**The production trading path should answer one question first: what is the production-safe trade posture right now?**

Everything else is secondary.

That means:
- base compute must be deterministic and minimal
- enrichment must be additive and fail-open
- notify must be strict about freshness and run identity

---

## Goals

### 1. Make the latest base artifact trustworthy

The newest base run should reliably answer:
- what is the market regime?
- what did CANSLIM find?
- what did Dip Buyer find?
- what is the final production-safe posture?

Explicit base requirements (agent):
- base compute is the only production-critical path
- base decides success/failure and writes the official artifact
- keep only regime refresh, CANSLIM/Dip Buyer core logic, production-safe gating, message generation, metrics
- artifact writes must be atomic (tmp + rename)
- base summary must include at least: `schema_version`, `run_id`, `status`, `created_at`, `started_at`, `finalized_at`, `notified_at`
- base `run_id` is the anchor for any enrichment or notify work

### 2. Make enrichments optional by architecture, not by convention

If enrichment fails:
- the base artifact must still be successful
- notify must still be able to send the base result

### 3. Make notifier behavior simple and correct

Notify should:
- read the latest completed base artifact
- only send the latest successful base artifact by default
- merge enrichment only if it belongs to the same base run and is fresh

### 4. Improve operator trust

An operator should be able to look at a run directory and immediately understand:
- whether base compute succeeded
- whether enrichment ran
- whether enrichment was merged
- what failed, if anything

---

## Non-Goals

This PRD does **not** include:
- new trading strategies
- new buy/sell logic
- direct auto-trading
- moving decision authority away from the Python regime/technical engine
- making Polymarket or council the primary strategy

---

## Compatibility Requirement

This refactor must remain compatible with the current operator workflow.

That means it should continue to work with:
- the existing OpenClaw cron setup
- the current compute and notify job split
- the current Telegram delivery flow

### Compatibility expectations

- existing cron entrypoints should be preserved during the transition whenever possible
- existing notify behavior should still produce operator-facing Telegram output from the latest valid base run
- the new decoupling should change internal responsibilities, not force a new manual workflow
- the refactor should be implemented as a compatibility-minded architectural cleanup, not as a breaking rewrite

### Practical meaning

From the outside, the workflow should still look familiar:
1. OpenClaw triggers the compute job
2. the system writes run artifacts
3. optional enrichments attach side artifacts
4. the notify job sends Telegram output

From the inside, the architecture becomes cleaner:
- compute owns the official base result
- enrichments are optional and fail-open
- notify reads the base result first and merges extras only if they are valid

Success here means:
- OpenClaw does not need a brand-new operational model
- Telegram still receives the right latest-run message
- the system becomes easier to extend without breaking the current automation path

---

## Target Architecture

## 1. Base Compute Layer

This is the only production-critical compute path.

### Responsibilities
- refresh or read the current regime snapshot
- run CANSLIM and Dip Buyer core logic
- enforce production-safe market gates
- produce the official base summary
- persist the official run outputs

### Required outputs
- `summary.json`
- `message.txt`
- `stdout.txt`
- `stderr.txt`
- `metrics.json`

### Rules
- no optional enrichment may block this path
- success/failure here defines the official latest run state
- this layer owns the truth that notify reads first
- artifact writes must be atomic (tmp + rename)
- base summary fields must include: `run_id`, `status`, `schema_version`, `created_at`, `started_at`, `finalized_at`, `notified_at`

### Allowed dependencies
- market regime
- core stock analysis
- core data fetches
- compact formatting

### Not allowed in the blocking path
- council session creation
- council vote orchestration
- experimental alpha
- deep contextual research that can fail independently
- subprocess-heavy enrichments

---

## 2. Enrichment Layer

This layer is optional and fail-open.

### Examples
- council deliberation
- Polymarket-derived ranking/context notes
- experimental alpha annotations
- research-only ranking overlays

### Responsibilities
- read the base artifact by run id
- compute additional annotations
- write separate enrichment artifacts
- never mutate the base run status

### Required outputs
Each enrichment should write a separate artifact with:
- `run_id`
- `generated_at`
- `status`
- `payload`
- `error` if failed

Example files:
- `council.json`
- `polymarket_overlay.json`
- `experimental_alpha.json`

### Rules
- enrichment must be linked to a specific base run id
- enrichment must not invalidate base success
- enrichment failures must be visible but non-blocking
- stale enrichment must not be merged into a newer run
- enrichment is never required for notify
- run against a specific `run_id` and write to `enrichments/` with its own status/timestamps

---

## 3. Notify Layer

This is the only layer that sends user-facing output.

### Responsibilities
- find the latest completed base run
- determine whether it is notify-eligible
- optionally merge fresh enrichment artifacts for the same run id
- send the final operator-facing message

### Rules
- never notify from an older success after a newer failure
- never merge enrichment from a different run id
- never require enrichment for a successful base notification
- failure notifications should be explicit and intentional, not accidental fallback behavior
- notify must be strict and idempotent
- read only the latest finalized base run
- ignore stale/failed/missing enrichments
- mark exactly one base run as notified

### Default policy
- latest successful base run is notifyable
- enrichments are merged only if:
  - they match the same run id
  - they are fresh
  - they are marked successful

---

## Proposed Artifact Contract

Every run should have a stable directory structure like:

```text
var/backtests/runs/<run_id>/
  summary.json
  message.txt
  stdout.txt
  stderr.txt
  metrics.json
  enrichments/
    council.json
    polymarket_overlay.json
    experimental_alpha.json
```

### Base summary fields
- `run_id`
- `strategy`
- `mode`
- `generated_at`
- `status`
- `market_regime`
- `decision`
- `confidence`
- `risk`
- `scanner_counts`
- `message_path`
- `metrics_path`

### Enrichment fields
- `run_id`
- `name`
- `generated_at`
- `status`
- `fresh_until`
- `payload`
- `error`

---

## Desired Runtime Flow

## Cron A: Base Compute

Steps:
1. refresh regime snapshot
2. run core scan logic
3. write base artifacts
4. exit based only on base compute result

Properties:
- deterministic
- bounded runtime
- minimal dependency surface

## Cron A.1: Enrichment

Steps:
1. find the latest base run
2. skip if base run failed
3. run optional enrichments against that run id
4. write enrichment artifacts
5. never rewrite base status

Properties:
- fail-open
- safe to retry
- can run serially or selectively

## Cron B: Notify

Steps:
1. read the latest completed base run
2. ensure it is success and unnotified
3. merge fresh matching enrichment artifacts if available
4. send final message
5. mark only that base run as notified

Properties:
- strict freshness
- no fallback to older success after newer failure
- no accidental cross-run merge

---

## Failure Policy

### Base compute failure
- latest run is `failed`
- notify sends nothing by default
- optional explicit failure notification can be enabled separately

### Enrichment failure
- base run remains `success`
- notify still sends base output
- enrichment failure is recorded in its own artifact

### Missing enrichment
- notify still sends base output

### Stale enrichment
- ignored for merge
- base output still sends

---

## What Should Move First

### Move out first
- council creation and voting
- experimental alpha annotations
- anything subprocess-heavy or env-sensitive

### Keep in base path
- regime snapshot
- CANSLIM / Dip Buyer scans
- compact unified message generation
- base metrics and run persistence

---

## Acceptance Criteria

This PRD is implemented successfully when:

1. A failed council or enrichment step no longer causes the latest base artifact to fail.
2. The latest successful base artifact can be notified even if enrichment failed.
3. Notify no longer needs fallback hacks to avoid stale messages.
4. Every enrichment artifact is tied to an explicit base `run_id`.
5. An operator can inspect one run directory and tell exactly:
   - base status
   - enrichment status
   - what was merged
   - what failed
6. Cron runtime becomes easier to reason about because the base path is smaller and more deterministic.

---

## Recommended Implementation Order

### Phase 1: Artifact contract cleanup
- formalize base artifact schema
- formalize enrichment artifact schema
- create `enrichments/` subdirectory per run

### Phase 2: Council decoupling
- remove council from blocking base compute
- run it as a post-compute enrichment
- merge only if fresh and matching

### Phase 3: Research decoupling
- move experimental alpha and similar research outputs to enrichment-only artifacts
- ensure they are annotation-only unless explicitly promoted

### Phase 4: Notify simplification
- make notifier consume one clear base artifact and optional matched enrichments
- remove stale or ambiguous fallback behavior

---

## Open Questions

1. Should failed base runs produce an explicit failure Telegram alert, or should they simply suppress notify by default?
2. Should enrichments run in a separate cron, or as a chained but fail-open post-compute job?
3. Which enrichments are worth keeping in the first decoupled version:
   - council only
   - council + Polymarket overlays
   - all enrichments

---

## Bottom Line

The next architecture step should not be “add more intelligence.”

It should be:
- make base compute small and trustworthy
- make enrichment optional by design
- make notify strict and simple

That gives you a system that is easier to operate, easier to debug, and safer to improve without breaking market-session reliability.
