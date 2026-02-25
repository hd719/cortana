# Inter-Agent Communication Gaps: Findings + Proposals

## TL;DR
Cortana’s current model is strong for **deterministic routing + sequential handoffs**, but weak for **mid-task agent collaboration**. The biggest gap is not planning quality — it is runtime communication primitives.

Right now, this operates as **hub-and-spoke orchestration** (Cortana-centered), not a true mesh.

---

## Scope Investigated
- Covenant orchestration/planning code:
  - `tools/covenant/planner.py`
  - `tools/covenant/critic.py`
  - `tools/covenant/executor.py`
  - `tools/covenant/route_workflow.py`
  - `tools/covenant/protocol_schema.json`
- Related docs:
  - `docs/covenant-orchestration-v2.md`
  - `docs/covenant-integration-strategy.md`
  - `docs/event-bus.md`
  - `docs/memory-engine-design.md`
- Boundary controls:
  - `tools/covenant/validate_memory_boundary.py`
- OpenClaw session tooling docs + issue reports (external):
  - Session tools docs (`sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`)
  - Reported mismatch where subagents may see session tool names but lack live bindings in some setups

---

## Current Capability Snapshot (What exists today)

## Strong
1. **Role routing + chain planning** (Planner → Critic → Executor) is deterministic and structured.
2. **Handoff contracts exist** (`input_contract`, `output_contract`, `deliver_to_step_id`).
3. **Completion callbacks work** (subagents finish and auto-announce up).
4. **Event bus exists** (Postgres durable table + LISTEN/NOTIFY transport).
5. **Memory engine exists** (`episodic`, `semantic`, `procedural` tables and ingestion paths).

## Weak / Missing
1. **No first-class in-flight A2A channel in Covenant runtime**.
2. **Handoffs are contract-level, not transport-level** (no guaranteed artifact exchange mechanism).
3. **Execution is dependency-sequential by default** (`executor.next_ready_step` returns one step; no parallel fan-out support).
4. **Shared context publication is implicit/manual** (not standardized per step).
5. **Subagents are ephemeral**; durable state is mostly Cortana-level, not identity-scoped runtime memory.
6. **Agent feedback loop is not targeted**; corrections flow to Cortana memory systems, but not explicitly to the originating specialist agent profile.

---

## Gap Analysis by Question

## 1) Agent-to-agent direct communication
**Finding:** Not reliably available in this runtime.

- In this environment, exposed tooling includes `subagents` with actions `list|kill|steer` (no direct `sessions_send` tool bound here).
- OpenClaw docs describe `sessions_send`, but subagent visibility/binding is config-dependent and may be clamped in sandboxed sessions.
- Net: direct mid-task agent messaging is **not guaranteed as a design primitive** for Covenant flows.

**Impact:** High. Prevents live clarification between specialists without routing through Cortana.

---

## 2) Shared context/memory between agents
**Finding:** Partial and manual.

- Planner defines `handoff.output_contract`, but that is schema intent, not a persisted transport layer.
- No mandatory “publish handoff artifact” step in executor runtime.
- Memory boundaries explicitly block broad long-term writes from subagents (`validate_memory_boundary.py`).

**Impact:** High. Context can be lost, truncated, or inconsistently relayed.

---

## 3) Real-time collaboration (parallel + shared progress)
**Finding:** Mostly sequential today.

- `executor.next_ready_step(...)` selects a single next step.
- No native fan-out/fan-in orchestration in Covenant executor semantics.
- Parallelism can happen operationally via multiple spawns, but no shared progress substrate is defined.

**Impact:** Medium-high. Slows multi-stream work (research + implementation + docs sync).

---

## 4) Cortana as bottleneck (hub-and-spoke constraints)
**Finding:** Yes, this is a structural bottleneck.

Current flow centralizes:
- planning,
- dispatch,
- quality gate decisions,
- most relay behavior.

This is good for control, but costs throughput and increases cognitive relay overhead.

**Impact:** Medium-high. Great for safety, weaker for velocity at scale.

---

## 5) Event bus integration
**Finding:** Infrastructure exists; agent workflow integration is thin.

- Event bus is productionized enough for local durable events (`cortana_event_bus_events` + publish/listener tooling).
- But Covenant agents are not systematically publishing step lifecycle events (started/progress/blocked/completed) or subscribing to task-relevant streams.

**Impact:** High leverage. Existing infra is underused.

---

## 6) Persistent agent state
**Finding:** Global memory exists; per-agent operational memory is immature.

- Memory engine has semantic/procedural layers that could support persistent learning.
- No consistent identity-scoped write/read contract tied to `agent_identity_id` for each run.
- Subagents are intentionally ephemeral, so continuity requires explicit ingest + scoped retrieval wiring.

**Impact:** Medium-high. Repeated relearning and quality variance run-to-run.

---

## 7) Feedback loops to specialist agents
**Finding:** Weak targeting.

- Feedback (`cortana_feedback`) exists.
- Reflection/memory ingestion exists.
- But no guaranteed loop says: “correction X updates prompt/context package for the same agent identity next run.”

**Impact:** High. Mistakes can recur in specialist roles.

---

## OpenClaw Tooling Reality: What is possible now vs custom build

## Possible now (with current stack)
1. **Central orchestration + deterministic chains** (already implemented).
2. **Asynchronous completion announce** (already implemented).
3. **Manual steering of active subagent** (`subagents steer`) by parent/orchestrator.
4. **Durable event stream** (Postgres event bus + listener/publisher).
5. **Durable memory layers** (episodic/semantic/procedural tables).

## Requires custom build / integration work
1. **Guaranteed subagent-to-subagent direct messaging** in Covenant runtime paths.
2. **Standard handoff artifact bus** (contract + storage + retrieval helpers).
3. **Parallel plan execution semantics** (fan-out/fan-in in executor + critic support).
4. **Identity-scoped persistent memory retrieval/injection for each spawn.**
5. **Agent-specific feedback compiler** (corrections -> per-agent policy updates).

---

## External Framework Patterns Worth Adopting

## AutoGen
- Group-chat manager pattern provides explicit turn coordination.
- Supports shared topic/message thread, but usually sequential turns.
- Useful lesson: **explicit coordinator + explicit message protocol** beats implicit relay.

## CrewAI
- Unified memory model with automatic extraction + pre-task recall.
- Crew-shared memory plus optional private scoped memory.
- Useful lesson: **shared + private memory scopes** should be first-class and automatic.

## LangGraph (supervisor ecosystem)
- Supervisor-driven multi-agent graph with state as a first-class object.
- Supports persistent checkpoints/store and explicit state transitions.
- Useful lesson: **state graph + checkpointing** is ideal for fan-out/fan-in and resumability.

## OpenAI Swarm (and successor Agents SDK direction)
- Lightweight handoffs between specialized agents; stateless core unless you add memory.
- Useful lesson: **handoffs are simple and powerful, but memory/persistence must be explicit**.

---

## Ranked Proposals (Impact × Feasibility)

| Rank | Proposal | Impact | Feasibility | Why it matters |
|---|---|---:|---:|---|
| 1 | **Handoff Artifact Bus (HAB)** | Very High | High | Eliminates context loss between chained agents immediately. |
| 2 | **Agent Feedback Compiler (AFC)** | High | High | Converts corrections into agent-specific improvements on next spawn. |
| 3 | **Covenant Event Lifecycle Integration** | High | Medium-High | Unlocks observability + loose coupling using existing event bus infra. |
| 4 | **Identity-Scoped Memory Injection** | High | Medium | Gives persistent specialization without violating boundaries. |
| 5 | **Parallel Step Execution (fan-out/fan-in)** | Medium-High | Medium | Improves throughput for decomposable tasks. |
| 6 | **Controlled A2A Mesh Channel** | Medium-High | Medium-Low | Reduces Cortana relay load while preserving governance. |

---

## Proposal Details

## 1) Handoff Artifact Bus (HAB) — **Do first**
Create a mandatory artifact record per completed step:
- `run_id`, `step_id`, `agent_identity_id`, `artifact_type`, `payload_ref`, `summary`, `confidence`, `created_at`

Mechanics:
- Step completion must publish a HAB entry before next step dispatch.
- Next step resolver loads prior required artifacts by contract keys.
- Large payloads stay in file/DB blobs; handoff record carries compact references.

Result:
- Handoffs become deterministic and auditable, not “hope the summary survived prompt packing.”

## 2) Agent Feedback Compiler (AFC)
Pipeline:
1. Capture correction + classify (`fact`, `behavior`, `quality`, `routing`).
2. Map to owning `agent_identity_id` and capability tag.
3. Generate compact “agent delta rules” for future spawn context.
4. Expire/supersede stale deltas when contradicted.

Result:
- Specialist agents actually improve over runs; feedback becomes identity-targeted.

## 3) Event Lifecycle Integration
Emit bus events at runtime milestones:
- `agent_step_started`
- `agent_step_progress`
- `agent_step_blocked`
- `agent_step_completed`
- `handoff_published`

Use existing `cortana_event_bus_events` as durable truth.

Result:
- Real-time monitoring, replay, analytics, and optional autonomous reactions.

## 4) Identity-Scoped Memory Injection
On spawn:
- Retrieve top-k semantic/procedural memories filtered by `agent_identity_id` + task tags.
- Inject as compact context pack (`what worked`, `known pitfalls`, `preferred outputs`).

On completion:
- Extract candidate procedural updates and queue for review/ingestion.

Result:
- Better consistency and less repetitive prompting.

## 5) Parallel Fan-Out / Fan-In in Executor
Extend plan schema:
- Allow multiple dependency-ready steps to dispatch concurrently.
- Add join gates (`fan_in_gate`) requiring N of M completions.

Guardrails:
- max parallel steps per run,
- bounded token/timeout budget,
- deterministic merge contract.

Result:
- Throughput gains for independent workstreams (e.g., research/doc prep in parallel with implementation prep).

## 6) Controlled A2A Mesh Channel
If/when session tools are reliably bound for subagents, add policy-gated direct message path:
- allow only same run/correlation_id,
- allowlisted target identities,
- short-lived capability token,
- mandatory transcript logging + announce summary.

Result:
- Removes avoidable Cortana relays while keeping auditability and control.

---

## Recommended Target Architecture (Balanced)

**Hybrid model:**
- Keep Cortana as policy/control plane (routing, safety, escalation).
- Add mesh-like data plane for **artifact exchange + event-driven coordination**.

So: **not pure mesh**, not pure hub-and-spoke — a controlled hybrid.

---

## Implementation Roadmap (practical order)

## Phase 1 (fast wins, low risk)
1. Implement HAB table + helper library.
2. Require artifact publish before handoff completion.
3. Emit lifecycle events from executor.

## Phase 2
1. Add identity-scoped memory retrieval/injection on spawn.
2. Build AFC job from `cortana_feedback` into agent-specific deltas.

## Phase 3
1. Add parallel fan-out/fan-in semantics to planner/executor/schema.
2. Pilot controlled A2A channel if session tools bindings are confirmed stable in subagents.

---

## Bottom Line
Cortana’s Covenant stack is already good at **who should do what next**. The missing layer is **how agents coordinate while work is in motion**.

Highest ROI move: implement **Handoff Artifact Bus + lifecycle event publishing** first. That solves context loss, unlocks observability, and creates the substrate needed for memory and mesh upgrades later.