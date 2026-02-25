# Cortana Strategic Self-Assessment — Feb 25, 2026

## Executive Read
Cortana is already strong on orchestration, resilience, and memory volume. The weakest links are **memory granularity**, **traceability**, and **quality/cost feedback loops**. The best next moves are improvements that close those gaps while acting as direct prototypes for Cortex Plane.

## Assessment Lens
Scored each initiative on:
- **Daily Impact**: How much this improves Cortana’s real day-to-day outcomes
- **Cortex Prototype Value**: How strongly it de-risks/validates Cortex Plane architecture
- **Feasibility (Mac mini + OpenClaw)**: Practicality right now
- **Priority**: 1 (highest) to 5 (lowest)

---

## Recommended Improvements (10)

### 1) Atomic Fact Extraction Pipeline (Conversation → Claims)
- **What to build now:** Add a post-conversation extractor that emits atomic facts (subject, predicate, object, confidence, source span, timestamp, scope) rather than storing only blob summaries.
- **Daily impact:** High. Better recall precision, fewer hallucinated memory merges, cleaner personalization.
- **Cortex prototype value:** Very high. Directly validates Cortex’s planned memory extraction pipeline.
- **Feasibility:** High (existing embeddings + Postgres + current event hooks).
- **Priority:** **1**

### 2) Memory Freshness + Supersession Chains
- **What to build now:** Add decay score + supersedes/superseded_by links in memory records. Old facts decay unless refreshed; conflicting facts form explicit supersession chains.
- **Daily impact:** High. Prevents stale memory poisoning and conflicting preference drift.
- **Cortex prototype value:** Very high. Mirrors Qdrant half-life/supersession design intent.
- **Feasibility:** Medium-high (schema changes + retrieval weighting logic).
- **Priority:** **1**

### 3) End-to-End Trace IDs + OpenTelemetry-Lite
- **What to build now:** Generate a trace_id per user request and propagate through planner/critic/executor, DB writes, tool calls, and final output. Persist spans to Postgres now; optional OTLP export later.
- **Daily impact:** High. Makes failures diagnosable in minutes instead of guesswork.
- **Cortex prototype value:** Very high. Bridges to full OpenTelemetry + Langfuse.
- **Feasibility:** High (incremental instrumentation).
- **Priority:** **1**

### 4) LLM Router Circuit Breaker (Sliding Window + Capability Tiers)
- **What to build now:** Health-aware router with rolling error/latency windows; degrade across model tiers (primary → fallback → local), with cooldown and auto-recovery.
- **Daily impact:** High. Better reliability under provider jitter and quota failures.
- **Cortex prototype value:** High. Direct precursor to planned failover design.
- **Feasibility:** Medium-high (policy engine + metrics counters).
- **Priority:** **1**

### 5) Token Economics Layer (Cost Ledger + Prompt Cache Hit-Rate)
- **What to build now:** Per-request token ledger by stage (planner/critic/executor/tools), cache keying for repetitive system/context blocks, and weekly waste report.
- **Daily impact:** High. Immediate cost reduction and lower latency.
- **Cortex prototype value:** High. Informs platform-wide budget policy and routing.
- **Feasibility:** High.
- **Priority:** **2**

### 6) Agent Output Quality Scorecards
- **What to build now:** Automatic rubric scoring per agent output (instruction adherence, factuality confidence, completion quality, correction rate). Feed back into Agent Feedback Compiler.
- **Daily impact:** Medium-high. Raises consistency and catches regressions quickly.
- **Cortex prototype value:** High. Establishes eval framework for multi-agent orchestration.
- **Feasibility:** Medium (rubrics + lightweight evaluator prompts).
- **Priority:** **2**

### 7) Conversation Insight Promotion Pipeline
- **What to build now:** Route extracted facts to staged states: candidate → verified → promoted (long-term memory), with confidence thresholds and human-approval path for sensitive classes.
- **Daily impact:** High. Prevents low-confidence junk from entering permanent memory.
- **Cortex prototype value:** High. Core to future durable knowledge lifecycle.
- **Feasibility:** Medium-high.
- **Priority:** **2**

### 8) Feedback Closure Verifier (Did We Actually Learn?)
- **What to build now:** For each feedback item/correction, auto-check future responses for compliance over N interactions, then mark reinforced/decayed.
- **Daily impact:** Medium-high. Converts “logged feedback” into measurable behavior change.
- **Cortex prototype value:** Medium-high. Strong primitive for continuous improvement loops.
- **Feasibility:** High.
- **Priority:** **2**

### 9) Proactive Signal Precision Tuning (Behavioral Twin Calibration)
- **What to build now:** Track precision/recall of proactive alerts (useful vs noise), add per-category thresholds and quiet-hour context features.
- **Daily impact:** Medium-high. Fewer noisy pings, better trust in proactive intelligence.
- **Cortex prototype value:** Medium-high. Becomes governance/notification policy backbone.
- **Feasibility:** High.
- **Priority:** **3**

### 10) Durable Workflow Checkpointing (Graphile-Worker-Lite in Postgres)
- **What to build now:** Implement checkpointable task state machine for long multi-step operations (queued/running/checkpointed/retry/succeeded/failed), idempotent resumes after interruption.
- **Daily impact:** Medium-high. Fewer lost runs, safer long operations.
- **Cortex prototype value:** Very high. Direct design spike for Graphile Worker durable state model.
- **Feasibility:** Medium (state machine + retry semantics).
- **Priority:** **2**

---

## Priority Order (Execution Sequence)
1. Atomic Fact Extraction Pipeline
2. End-to-End Trace IDs + OTel-Lite
3. LLM Router Circuit Breaker
4. Memory Freshness + Supersession Chains
5. Token Economics Layer
6. Conversation Insight Promotion Pipeline
7. Agent Output Quality Scorecards
8. Feedback Closure Verifier
9. Durable Workflow Checkpointing
10. Proactive Signal Precision Tuning

## Why this order
- First four remove the biggest correctness/reliability blind spots.
- Middle four increase quality-per-token and make learning loops real.
- Final two lock in long-run operational maturity and autonomy trust.

## Expected 30-Day Outcome (if executed)
- Noticeably higher memory precision and fewer stale/conflicting recalls
- Faster root-cause analysis for agent/tool failures
- Lower token burn with clearer cost attribution
- Measurable gains in output consistency and correction retention
- Higher trust in proactive recommendations due to reduced alert noise
- Early validated building blocks for Cortex Plane architecture choices
