# Mission Control v2 Research — Approvals, Council, Feedback Patterns

## 1) Executive summary (what to build, in priority order)

### Recommendation: Build these 3 features first

1. **Risk-based Approvals Inbox (highest impact, medium complexity)**
   - Why first: immediate safety + trust layer for autonomous actions (tool calls, external writes, destructive commands).
   - Pattern validated by: LangGraph interrupts/checkpointing, OpenAI Agents SDK tool approvals, CrewAI HITL.
   - Outcome: safer autonomy without slowing low-risk work.

2. **Feedback → Rule Pipeline (high impact, medium complexity)**
   - Why second: converts corrections into durable prevention, not one-off comments.
   - Pattern validated by: Langfuse trace-linked feedback + score filtering, AgentOps session drilldown/waterfall observability model.
   - Outcome: measurable quality compounding (fewer repeated mistakes).

3. **Council Deliberation View (selective use, medium-high complexity)**
   - Why third: useful for high-stakes/ambiguous decisions; overkill for routine tasks.
   - Pattern validated by: AutoGen group chat manager + speaker selection, research on multi-agent debate.
   - Outcome: better decision quality for strategic or uncertain tasks.

### Strong opinion
For a **single-user Covenant + Postgres + Next.js** setup, the winning sequence is:
**Approvals first, Feedback second, Council third.**
If you invert this, you get fancy collaboration before governance and learning hygiene.

---

## 2) Approvals deep dive (patterns, schemas, UI)

## A. How production systems gate actions

### Common architecture
1. Agent proposes action (tool call / side effect).
2. Runtime computes risk (policy + context).
3. If low risk and policy allows: auto-approve + execute.
4. If gated: pause execution, create approval record, notify human.
5. Human can approve/edit/reject.
6. Runtime resumes from persisted checkpoint.
7. Full audit trail retained.

### Evidence from frameworks
- **LangGraph**: `interrupt()` pauses execution; durable checkpoint + thread_id resume model. This is a first-class pause/resume primitive for HITL gating.
- **LangChain Deep Agents**: `interrupt_on` per tool with decision controls (`approve`, `edit`, `reject`).
- **OpenAI Agents SDK (JS)**: tools can declare `needsApproval` (boolean or function), run returns interruptions, user approves/rejects then run resumes.
- **CrewAI**: flow-based human feedback and enterprise webhook-based async human review.

### Core design lesson
The critical implementation detail is not the button click. It’s **durable pause state** + **idempotent resume** + **decision trace**.

## B. UI patterns that work best

### 1) Inbox-style approvals queue (best default)
- Columns: Pending / Expiring / Approved / Rejected.
- Sort by: risk, urgency, expiry, blast radius.
- Best for single operator workflows.

### 2) Split-pane diff review (must-have for edits)
- Left: proposed args/content.
- Right: editable args/content + policy warnings.
- “Approve as-is” / “Approve with edits” / “Reject”.

### 3) Optional Kanban for teams
- Useful when multiple approvers/rotations exist.
- Probably not phase-1 priority for your single-user setup.

## C. Urgency + risk tiering model

Use a 4-tier matrix:
- **P0 Critical / destructive / external side-effect**: mandatory approval, short SLA, loud alert.
- **P1 High impact**: mandatory approval unless explicit trusted policy.
- **P2 Medium**: approval optional by context; auto if confidence high and scope constrained.
- **P3 Low read-only/internal**: auto-approve by default.

### Auto-approval policy examples
Auto-approve if all true:
- tool is in allowlist,
- scope <= threshold,
- no external write,
- no secrets/PII touched,
- confidence >= threshold,
- no recent similar rejection.

## D. Proposed schema (PostgreSQL)

```sql
create table mc_approval_requests (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  task_id uuid,
  agent_id text not null,
  action_type text not null,              -- tool_call, file_write, message_send, deploy, etc.
  proposal jsonb not null,                -- raw proposed action payload
  diff jsonb,                             -- optional structured diff
  rationale text,

  risk_level text not null check (risk_level in ('p0','p1','p2','p3')),
  risk_score numeric(5,2),                -- optional 0-100
  blast_radius text,                      -- local, workspace, external
  auto_approvable boolean not null default false,
  policy_version text,

  status text not null default 'pending'  -- pending, approved, approved_edited, rejected, expired, cancelled
    check (status in ('pending','approved','approved_edited','rejected','expired','cancelled')),
  decision jsonb,                         -- edited args, rejection reason, etc.
  approved_by text,
  approved_at timestamptz,
  rejected_by text,
  rejected_at timestamptz,

  created_at timestamptz not null default now(),
  expires_at timestamptz,
  resumed_at timestamptz,
  executed_at timestamptz,
  execution_result jsonb
);

create index mc_approval_requests_status_idx on mc_approval_requests(status, risk_level, expires_at);
create index mc_approval_requests_run_idx on mc_approval_requests(run_id);
```

Add event log table for immutable audit:
```sql
create table mc_approval_events (
  id bigserial primary key,
  approval_id uuid not null references mc_approval_requests(id) on delete cascade,
  event_type text not null,               -- created, policy_eval, approved, edited, rejected, expired, resumed, executed
  actor text,
  payload jsonb,
  created_at timestamptz not null default now()
);
```

## E. Recommended approvals page wireframe (text)

- Top filters: `All | Pending | Expiring | High Risk | My Decisions`
- Left list: compact cards (risk badge, action summary, agent, age, expiry countdown)
- Right detail panel:
  - Proposed action + arguments
  - Policy/risk explanation (“why gated”)
  - Diff editor (if editable)
  - Buttons: Reject / Approve / Approve with edits
  - Audit trail timeline below

---

## 3) Council deep dive (patterns, architecture, UI)

## A. What “council” is (and is not)

**Council != chain.**
- Chain: deterministic handoff, one path.
- Council: multiple specialized agents produce competing/complementary views, then a selector/judge resolves.

## B. Real implementation patterns

### 1) Group chat manager pattern (AutoGen)
- Shared topic/thread.
- Manager selects next speaker (round-robin, random, manual, or LLM selector).
- Termination rule ends loop.
- Strength: transparent transcript of deliberation.

### 2) Debate-then-decide pattern
- N agents propose answers.
- Cross-critique round(s).
- Judge/aggregator finalizes.
- Supported conceptually by multi-agent debate literature showing gains on reasoning/factual tasks.

### 3) Weighted expertise voting
- Assign role weights (security=0.4, reliability=0.3, product=0.3 etc.).
- Weighted score decides, with tie-break policy.
- Best for repeatable governance decisions.

## C. Consensus mechanisms to support

Implement 3 modes:
1. **Majority vote** (simple default)
2. **Weighted vote** (role-sensitive decisions)
3. **Debate + judge** (high ambiguity/high stakes)

## D. Council schema (PostgreSQL)

```sql
create table mc_council_sessions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid,
  topic text not null,
  objective text,
  mode text not null check (mode in ('majority','weighted','debate_judge')),
  status text not null default 'running' check (status in ('running','decided','cancelled','timeout')),
  created_by text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  final_decision jsonb,
  confidence numeric(5,2),
  rationale text
);

create table mc_council_members (
  id bigserial primary key,
  session_id uuid not null references mc_council_sessions(id) on delete cascade,
  agent_id text not null,
  role text,
  weight numeric(6,3) not null default 1.0,
  stance text,
  vote text,
  vote_score numeric(6,3),
  reasoning text,
  responded_at timestamptz
);

create table mc_council_messages (
  id bigserial primary key,
  session_id uuid not null references mc_council_sessions(id) on delete cascade,
  turn_no int not null,
  speaker_id text not null,
  message_type text not null,             -- proposal, critique, rebuttal, vote, judge_summary
  content text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);
```

## E. Council UI wireframe (text)

- Header: objective, mode, timeout, status.
- Left panel: transcript with role-colored messages.
- Right panel:
  - live vote tally (counts or weighted bars),
  - confidence meter,
  - “arguments for/against” summary clusters,
  - final resolution card.
- Footer actions: “Escalate to human approval”, “Rerun with different panel”, “Adopt decision”.

---

## 4) Feedback deep dive (patterns, visualization, UI)

## A. What good feedback systems do

Not just store comments — they link feedback to execution traces, then drive remediation loops:
**feedback → diagnosis → rule/prompt/tool change → verification**.

### Evidence from production observability products
- **Langfuse**: feedback stored as trace-linked scores; filter low-rated traces for targeted review.
- **AgentOps**: session drilldowns + waterfall event timeline for debugging repeated failures.

## B. Feedback taxonomy to implement

Capture dimensions:
- category (factuality, policy, style, latency, tool misuse, unsafe action, hallucination)
- severity (low/med/high/critical)
- source (user/system/evaluator)
- recurrence key (normalized fingerprint of failure)
- disposition (accepted/rejected/deferred)

## C. Visual correction loop that works

### Feedback page should include 4 blocks:
1. **Inbox** of recent corrections (filterable by severity/category).
2. **Case view** with linked run trace + exact offending step.
3. **Remediation pipeline** status:
   - Logged
   - Rule drafted
   - Rule merged
   - Verified in production
4. **Trend analytics**:
   - correction rate over time,
   - recurring mistake leaderboard,
   - “time-to-fix” and “reopen rate”.

## D. Feedback schema (PostgreSQL)

```sql
create table mc_feedback_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid,
  task_id uuid,
  agent_id text,
  source text not null check (source in ('user','system','evaluator')),
  category text not null,
  severity text not null check (severity in ('low','medium','high','critical')),
  summary text not null,
  details jsonb,

  recurrence_key text,
  status text not null default 'new' check (status in ('new','triaged','in_progress','verified','wont_fix')),
  owner text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table mc_feedback_actions (
  id bigserial primary key,
  feedback_id uuid not null references mc_feedback_items(id) on delete cascade,
  action_type text not null,              -- prompt_patch, policy_rule, tool_guard, test_case
  action_ref text,                        -- commit hash / rule id / test id
  description text,
  status text not null check (status in ('planned','applied','verified','failed')),
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

create materialized view mc_feedback_metrics as
select
  date_trunc('day', created_at) as day,
  count(*) as total_feedback,
  count(*) filter (where severity in ('high','critical')) as severe_feedback,
  count(*) filter (where status='verified') as verified_count
from mc_feedback_items
group by 1;
```

## E. KPI set
- Recurring error rate (same recurrence_key / 7d)
- Median time to verified fix
- High-severity backlog
- % feedback mapped to an action
- Regression rate (verified issue reappears)

---

## 5) Product identification (the screenshot app)

## Findings
- The nav set `Tasks, Agents, Content, Approvals, Council, Calendar, Projects, Memory, Docs, People, Office, Team, Feedback` strongly resembles **OpenClaw Mission Control variants/custom forks**, not a standard Dust/Relevance/Letta/Julep default UI.
- Web search surfaced **openclaw-mission-control** repositories and related “Mission Control” content with governance/approvals language.
- No authoritative public match found for an off-the-shelf product with exactly that left nav taxonomy.

## Most likely conclusion
**Likely a custom Mission Control build (or fork) in the OpenClaw ecosystem**, rather than a stock UI from Dust/Letta/Relevance/Composio/Julep.

Confidence: **medium**.

---

## 6) Recommended implementation plan for your stack (single user, Covenant, Postgres, Next.js)

## Phase 1 (1–2 weeks): Approvals v1
- Build DB tables: `mc_approval_requests`, `mc_approval_events`.
- Add runtime wrapper around sensitive actions to emit approval requests + pause run state.
- Implement Next.js page `/approvals` with split-pane queue and action panel.
- Add simple policies YAML/JSON in repo (risk tiers + auto-approve rules).

Complexity: **Medium**

## Phase 2 (1–2 weeks): Feedback loop v1
- Build tables: `mc_feedback_items`, `mc_feedback_actions`.
- Add “Give feedback” on runs/tasks with category/severity quick tags.
- Build `/feedback` page with inbox + case detail + remediation status.
- Add metrics cards + daily trend chart.

Complexity: **Medium**

## Phase 3 (2–3 weeks): Council v1
- Build tables: `mc_council_sessions`, `mc_council_members`, `mc_council_messages`.
- Implement mode: majority first, then weighted voting.
- Build `/council` page with transcript + tally + final decision card.
- Add “Escalate to approval” bridge into approvals queue.

Complexity: **Medium-High**

## What to steal vs build custom

### Steal/adapt
- **Pause/resume semantics** from LangGraph/OpenAI Agents SDK.
- **Per-tool approval config** (`needsApproval` / `interrupt_on`).
- **Trace-linked feedback + filter model** from Langfuse.
- **Timeline/waterfall diagnostics pattern** from AgentOps.
- **Selector manager concept** from AutoGen group chat.

### Build custom
- Risk scoring tuned to your toolset and operational tolerance.
- Council role definitions and weighting aligned to Covenant agent roster.
- Feedback-to-rule automation (because this is your compounding advantage).
- Mission Control IA/nav and UX for single-operator speed.

---

## 7) Source URLs

### Core approvals / HITL
- https://docs.langchain.com/oss/python/langgraph/interrupts
- https://docs.langchain.com/oss/python/deepagents/human-in-the-loop
- https://openai.github.io/openai-agents-js/guides/human-in-the-loop/
- https://docs.crewai.com/en/learn/human-in-the-loop
- https://www.langchain.com/langgraph

### Council / multi-agent deliberation
- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/group-chat.html
- https://microsoft.github.io/autogen/0.2/docs/tutorial/conversation-patterns/
- https://microsoft.github.io/autogen/0.2/docs/topics/groupchat/customized_speaker_selection/
- https://arxiv.org/abs/2305.14325
- https://openreview.net/forum?id=QAwaaLJNCk
- https://github.com/openai/swarm
- https://developers.openai.com/cookbook/examples/orchestrating_agents/

### Feedback / observability patterns
- https://langfuse.com/docs/observability/features/user-feedback
- https://langfuse.com/docs/metrics/features/custom-dashboards
- https://langfuse.com/docs/observability/data-model
- https://docs.agentops.ai/v1/usage/dashboard-info

### Product identification leads
- https://github.com/abhi1693/openclaw-mission-control
- https://github.com/crshdn/mission-control
- https://www.dan-malone.com/blog/mission-control-ai-agent-squads
- https://docs.dust.tt/docs/collaboration
- https://askance.app/

---

## Final build call
If you want Mission Control v2 to feel “production-grade,” treat **Approvals + Feedback** as core infrastructure and **Council** as a precision instrument for hard calls. That ordering gives you safety, learning, and only then strategic deliberation depth.