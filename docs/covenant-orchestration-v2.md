# Covenant Orchestration v2: Planner → Critic → Executor

## Why v2
The previous Covenant routing logic selected an agent (or handoff chain) but did not enforce a structured orchestration lifecycle. v2 introduces:
- deterministic planning with dependency ordering,
- pre-execution critique and budget validation,
- execution-state decisions with retry/escalation policy,
- confidence thresholds and quality gates between phases,
- a structured handoff contract for inter-agent communication.

## Architecture

### 1) Planner (`tools/covenant/planner.py`)
Inputs: routing request (`objective`, `intents`, optional `handoff_pattern`, optional budget hints).

Planner responsibilities:
- Classify request by token signals and explicit pattern overrides.
- Produce `steps[]` with:
  - `step_id`
  - `agent_identity_id`
  - `depends_on`
  - `confidence` and `confidence_threshold`
  - per-step `retry_policy`
  - step `quality_gate`
  - step `handoff` contract
- Emit top-level `quality_gates`:
  - `pre_execution`: critic approval + structural checks
  - `pre_completion`: all steps + all gates + final confidence

### 2) Critic (`tools/covenant/critic.py`)
Inputs: planner output + optional request budget.

Critic responsibilities:
- Validate plan integrity:
  - known agent identities,
  - dependency references,
  - confidence threshold compliance,
  - step quality gate presence,
  - handoff schema presence.
- Validate resource budget:
  - aggregate timeout (`timeout_seconds` sum),
  - aggregate retries (`max_retries` sum),
  - compare to request/cluster thresholds.
- Output:
  - `approved` boolean,
  - `requires_human_review`,
  - `issues[]`, `warnings[]`,
  - computed resource totals.

Policy: any step below confidence threshold blocks approval and requires re-planning or human review.

### 3) Executor (`tools/covenant/executor.py`)
Inputs: plan + critique + optional completion/failure events.

Executor responsibilities:
- Halt execution when critic rejects plan.
- Select next dependency-ready step.
- Apply retry/escalation logic on failures:
  - hard failures (`auth_failure`, `permission_denied`, `requirements_ambiguous`) => immediate escalate,
  - transient failures within retry budget => retry same agent,
  - retry exhausted/non-transient => escalate with route suggestion.
- Return machine-readable execution state:
  - `state` (`queued|running|blocked|completed`),
  - `current_step_id`,
  - `next_action`,
  - `retry_decision`.

## Router Integration
`tools/covenant/route_workflow.py` now orchestrates PCE:
1. Planner creates the execution plan.
2. Critic validates and budgets it.
3. Executor produces dispatch-ready next action.

For `--plan`, router emits one envelope:
- `request`
- `plan`
- `critique`
- `execution`
- `protocol_version = covenant-pce-v2`

For `--failure`, router uses executor retry policy logic for a deterministic failure playbook.

## Handoff Protocol
Per-step handoff object defines:
- `input_contract`: required inbound context,
- `output_contract`: required outbound payload,
- `deliver_to_step_id`: next step target.

This standardizes inter-agent communication and prevents free-form handoff drift.

## Confidence Thresholds + Quality Gates
- Every step carries `confidence` and `confidence_threshold`.
- Critic rejects plans where confidence < threshold.
- Step-level quality gates enforce output contract, boundary compliance, and confidence checks.
- Global gates enforce phase transitions:
  - plan → execute: structural and budget readiness,
  - execute → complete: end-to-end validation.

## New Artifacts
- `tools/covenant/protocol_schema.json` — schema for request/plan/critique/execution envelope.
- `tools/covenant/planner.py` — planning engine.
- `tools/covenant/critic.py` — plan quality and budget evaluator.
- `tools/covenant/executor.py` — runtime dispatch/retry/escalation policy engine.
- `tools/covenant/route_workflow.py` — upgraded orchestration router.

## Operational Notes
- v2 is additive at orchestration level and keeps existing agent identity IDs.
- Existing spawn validation tools remain authoritative for identity contract enforcement.
- Next phase can wire executor outputs directly into spawn/dispatch runtime for autonomous step progression.
