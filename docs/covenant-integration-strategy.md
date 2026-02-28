# Covenant Integration Strategy: Route-First Sub-Agent Spawning

## Executive Summary
Cortana currently bypasses Covenant routing at dispatch time, so agent choice is often manual and inconsistent. The fix is simple and strict: **every spawn must pass through a pre-spawn routing gate** that calls `route_workflow.py --plan` and converts the returned plan/chain into one or more actual sub-agent spawns.

The biggest modeling gap is that current routing has no `Researcher` identity and overloads `Oracle` with research/analysis keywords. With the current code, research tasks are structurally misrouted.

---

## 1) Current Routing Gaps (from `route_workflow.py` + `planner.py`)

## 1.1 `route_workflow.py` gaps
- `ALLOWED_AGENTS` only includes:
  - `agent.monitor.v1`
  - `agent.huragok.v1`
  - `agent.oracle.v1`
  - `agent.librarian.v1`
- **Missing `agent.researcher.v1`** entirely.
- Orchestration itself is fine (`build_plan` → `review_plan` → `build_execution_state`), but it is only useful if Cortana actually invokes it before spawn.
- Failure playbook validation (`plan_failure`) also cannot accept `agent.researcher.v1`, so even retry/escalation logic cannot represent the desired roster.

## 1.2 `planner.py` gaps
- Agent constants do not define `Researcher`; `Oracle` is currently used as research/decision support.
- `KEYWORDS` map research-intent terms (`research`, `compare`, `investigate`, `evaluate`) to `AGENT_ORACLE`.
- `HANDOFF_PATTERNS` include:
  - `oracle_librarian_huragok`
  - `monitor_huragok_monitor`
  - `librarian_huragok_librarian`
  - **No researcher-led chains**.
- Weak-signal fallback defaults to Huragok (`scores[primary] == 0`), which can silently misroute ambiguous tasks into implementation.
- `normalize_tokens` is minimal (string split + simple payload fields), so intent detection misses natural language variants and role cues.

## 1.3 Concrete misroutes happening now
1. **Research requests** ("compare options", "investigate X", "deep dive") route to Oracle instead of Researcher.
2. **Strategic forecasting** and **pure research** are conflated under Oracle.
3. **Documentation after research** is not naturally represented as `Researcher -> Librarian`; closest available chain starts with Oracle.
4. **Ambiguous asks** bias toward Huragok, increasing risk of premature implementation.

---

## 2) Integration Design: Make Router Mandatory Before Every Spawn

## Recommendation: Pre-spawn routing gate (hard requirement)
Use routing as a required control point, not optional guidance.

### Why this design is best
- Inline/manual selection inside Cortana prompt is easy to bypass.
- AGENTS.md instructions alone are advisory and drift-prone.
- A pre-spawn gate is enforceable, testable, and auditable.

## Target architecture
1. **Task Intake (Cortana main/session logic)**
   - Build a `routing-request.json` with:
     - `objective`
     - `intents` (if known)
     - `workflow_type` (optional)
     - `constraints`, `resource_budget`, `max_steps`
2. **Mandatory router call**
   - `python3 /Users/hd/openclaw/tools/covenant/route_workflow.py --plan <routing-request.json>`
3. **Critique gate**
   - If `critique.approved=false` or `execution.state=blocked`, do not spawn; trigger replan/human clarification.
4. **Spawn plan execution**
   - For single-agent plan: spawn that identity.
   - For chain plan: spawn step 1, then subsequent steps only after previous completion+quality gate.
5. **Failure routing loop**
   - On step failure: call `route_workflow.py --failure <failure-event.json>`.
   - Apply returned action (`retry_same_agent`, `escalate_*`).

## Enforcement points
- **Code-level:** spawn helper must reject requests that do not include a router result object.
- **Process-level:** AGENTS.md and `covenant/CORTANA.md` should state “No spawn without router output”.
- **Validation-level:** handshake schema should require `agent_identity_id` from router unless explicitly human-overridden with `override_reason`.

---

## 3) Updated Intent → Agent Mapping (with signal patterns)

## 3.1 Proposed identity model changes
Add `agent.researcher.v1` and narrow `agent.oracle.v1` to forecasting/risk/decision modeling.

### Agent mapping recommendations

- **Huragok (systems engineering)**
  - Signals: `implement`, `build`, `fix`, `patch`, `refactor`, `test`, `debug`, `migrate`, `deploy`, `wire`, `automation`, `service`, `infra`
  - Negative signals (avoid direct routing): pure research verbs (`compare`, `survey`, `find sources`)

- **Researcher (research/scout)**
  - Signals: `research`, `deep dive`, `compare`, `benchmark`, `evaluate options`, `market scan`, `sources`, `literature`, `find evidence`, `pros and cons`
  - Output emphasis: evidence set, comparisons, ranked options, confidence.

- **Monitor (patterns/guardian)**
  - Signals: `monitor`, `watch`, `anomaly`, `incident`, `triage`, `health`, `uptime`, `alert`, `detect`, `verify recovery`, `drift`

- **Oracle (forecasting/strategy)**
  - Signals: `forecast`, `predict`, `risk`, `scenario`, `what should we do`, `decision model`, `tradeoff`, `probability`, `expected value`, `timing`
  - Important boundary: Oracle uses existing evidence; if new evidence gathering is primary, route first to Researcher.

- **Librarian (knowledge/docs)**
  - Signals: `document`, `write doc`, `README`, `runbook`, `spec`, `contract`, `architecture doc`, `summarize into docs`, `index`, `knowledge base`

## 3.2 Priority logic (to resolve overlaps)
When multiple intents appear:
1. **Docs terms present + no implementation verbs** → Librarian.
2. **Forecast/risk terms present + decision framing** → Oracle.
3. **Evidence-gathering terms dominate** → Researcher.
4. **Implementation verbs dominate** → Huragok.
5. **Health/anomaly/incident terms dominate** → Monitor.

For mixed asks, generate a chain rather than forcing one agent.

---

## 4) Handoff Chain Design for Multi-Agent Tasks

## Core principle
Use short, role-pure chains where each step has a strict input/output contract. Avoid role bleed.

## Recommended chain catalog

1. **Research -> Strategy -> Implementation**
   - `Researcher -> Oracle -> Huragok`
   - Use when: evidence gathering is needed before strategic choice and build action.

2. **Research -> Documentation**
   - `Researcher -> Librarian`
   - Use when: output is knowledge artifact, report, runbook, or README update.

3. **Research -> Documentation -> Implementation**
   - `Researcher -> Librarian -> Huragok`
   - Use when: evidence should become a stable spec before coding.

4. **Monitor -> Huragok -> Monitor**
   - Existing good pattern for incidents and recovery verification.

5. **Oracle -> Librarian**
   - Use when: decision model/forecast must be codified into operational guidance.

## Step contract template
Each step should emit:
- `summary`
- `artifacts` (paths)
- `risks`
- `confidence`
- `handoff_notes` (what next agent must do)

Next step should refuse to run if required artifacts from prior step are missing.

---

## 5) Concrete Implementation Plan

## Phase 1: Identity and router parity
1. Add `agent.researcher.v1` to:
   - `agents/identities/registry.json`
   - `tools/covenant/route_workflow.py` (`ALLOWED_AGENTS`)
   - `tools/covenant/critic.py` (`ALLOWED_AGENTS`)
   - `tools/covenant/executor.py` route suggestions as needed
2. Update Roland constants and keyword maps:
   - create `AGENT_RESEARCHER`
   - move research keywords from Oracle to Researcher
   - constrain Oracle to forecast/risk/strategy terms
3. Add new handoff patterns in `planner.py` for Roland:
   - `researcher_oracle_huragok`
   - `researcher_librarian`
   - `researcher_librarian_huragok`

## Phase 2: Spawn-path enforcement
1. Introduce/upgrade a single spawn entrypoint (wrapper) used by Cortana.
2. Wrapper must:
   - require routing request
   - call router
   - validate critique approval
   - produce spawn payload with routed identity/chain
3. Reject direct/manual spawn attempts unless `manual_override=true` + `override_reason`.

## Phase 3: Prompt and doc alignment
1. Update `covenant/CORTANA.md` examples to include Researcher and route-first flow.
2. Update AGENTS.md routing table to match code exactly.
3. Add tests/fixtures for each agent-intent and chain.

## Phase 4: Observability
Log per-run fields (DB or JSONL):
- raw objective
- router tokens/intents
- selected agent/chain
- override flag
- completion quality outcome

Track weekly:
- misroute rate
- override rate
- chain completion success
- escalation frequency by agent

---

## 6) Guardrails to Prevent Regression
- **No default-to-Huragok on zero signal** without asking for clarification; better: `requires_human_review=true` for low-confidence ambiguous inputs.
- Add confidence threshold per routing decision and explicit “insufficient intent signal” issue.
- Enforce that every spawned label includes routed agent identity and step id (`researcher-<slug>-s1`).

---

## 7) Final Recommended Policy
1. **Router is mandatory** before every spawn.
2. **Research is owned by Researcher**, not Oracle.
3. **Oracle is forecasting/decision modeling only.**
4. **Mixed-intent tasks become handoff chains, not role compromises.**
5. **Manual overrides are allowed but auditable and rare.**

This gives Cortana deterministic routing, cleaner role boundaries, and measurable orchestration quality instead of prompt-era guesswork.
