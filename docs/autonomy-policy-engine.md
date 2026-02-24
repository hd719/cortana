# Autonomy Policy Engine

## Why this exists
Cortana already has good instincts in `AGENTS.md` (safety rules, external-vs-internal boundaries, self-healing tiers), but those rules are narrative text. This engine turns them into **structured, queryable policy decisions** so autonomous execution can scale safely.

Goals:
- Increase safe autonomy (do more without waiting)
- Keep human control for high-risk/high-impact actions
- Make every decision auditable and explainable

---

## Scope
The engine evaluates one proposed action at a time and returns:
- `allow`: action can execute now
- `ask`: action needs explicit approval
- `deny`: action is blocked
- `alert`: action may execute but should notify Hamel (Tier 2 behavior)

It combines:
1. **Action policies** (category + operation + channel constraints)
2. **Budget policies** (token/API budget per window)
3. **Risk scoring** (weighted + threshold-driven)
4. **Escalation rules** (tiered handling)
5. **Temporary overrides** (time-boxed permission grants)
6. **Audit trail** (every check persisted)

---

## Policy model
Policies are defined in `tools/policy/policies.yaml`.

### 1) Action policy
Each action is mapped to a category and default autonomy posture:
- `internal_read`, `internal_write`, `internal_safe_fix`
- `external_message`, `external_publish`
- `destructive_change`, `infra_change`, `money_movement`, `privacy_sensitive`

Each category has:
- `base_decision`: allow/ask/deny
- `requires_approval`: bool
- `risk_base`: baseline risk contribution
- optional constraints (e.g., allowed channels)

This formalizes AGENTS.md:
- internal non-destructive operations are generally autonomous
- external-facing / destructive / permanent changes require approval

### 2) Budget policy
Budget windows are attached per cost type:
- `tokens` (LLM usage)
- `api_usd`
- `tool_calls`

Each policy defines:
- `window` (e.g. `1h`, `24h`, `7d`)
- `limit`
- `warn_at` threshold
- `hard_stop` behavior

The engine accepts observed usage and projected cost for the requested action. If projected usage exceeds hard limits, decision escalates to `ask` or `deny` depending on policy.

### 3) Risk scoring
Risk score is additive with bounded output (0-100):
- category base risk
- action modifiers (external, destructive, money, privacy)
- confidence penalty (`1 - confidence`)
- optional context boosts (unknown target, bulk operation)

Thresholds:
- `0-34`: low risk (auto)
- `35-64`: medium risk (alert/ask depending on category)
- `65+`: high risk (ask or deny)

### 4) Escalation rules (maps to AGENTS tier model)
- **Tier 1 (auto-fix)**: low-risk internal safe fixes (allow)
- **Tier 2 (alert + suggest)**: medium-risk internal optimizations (alert)
- **Tier 3 (ask first)**: external-facing, destructive, infra/config changes (ask)
- explicit deny class for disallowed behavior (deny)

### 5) Policy overrides
Hamel can grant temporary overrides scoped by:
- action category and/or action id
- max risk allowed
- optional budget bump
- expiry timestamp
- reason + issuer

Overrides never bypass hard-deny categories marked `immutable: true`.

### 6) Audit trail
Every policy check writes to `cortana_policy_decisions` with:
- requested action context
- computed risk and budget snapshot
- policy/override references
- final decision + rationale

This enables postmortems, trend analysis, and confidence tuning.

---

## Database additions
Migration `009_autonomy_policy.sql` introduces:
- `cortana_action_policies`
- `cortana_budget_policies`
- `cortana_policy_overrides`
- `cortana_policy_budget_usage`
- `cortana_policy_decisions`

and views:
- `cortana_policy_overrides_active`
- `cortana_policy_decisions_recent`

---

## Runtime flow
1. Receive action request (category, operation, target, projected cost)
2. Resolve matching action policy from YAML
3. Compute risk score
4. Evaluate relevant budget windows
5. Apply active override if present and valid
6. Determine final decision with escalation rule
7. Persist audit record
8. Return structured response to caller

---

## Python engine
`tools/policy/engine.py` provides:
- `PolicyEngine` class
- `evaluate(request, usage_snapshot, now)` method
- deterministic scoring + decision object
- optional DB helpers for inserts/lookups (safe fallback if DB unavailable)

The engine is intentionally lightweight so heartbeat/task executors can call it before taking autonomous actions.

---

## Example decisions
- Restart a stuck local process with low confidence but no external effect:
  - category `internal_safe_fix`, low budget impact, risk < 35 → `allow`
- Send outbound Telegram/Email message:
  - category `external_message` → `ask` unless explicit temporary override
- Delete files outside session temp scope:
  - category `destructive_change` + high risk → `ask` or `deny` depending on path policy
- API spend spike over limit:
  - budget hard-stop reached → `ask` (or `deny` if policy strict)

---

## Operational notes
- Keep YAML as source-of-truth for behavior tuning.
- Persist policy snapshots periodically into DB for analytics.
- Review high-risk `ask` decisions weekly to safely expand autonomy where possible.
- Expired overrides should be auto-pruned by periodic maintenance job.
