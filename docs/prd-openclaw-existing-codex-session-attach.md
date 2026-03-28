# PRD — Connect OpenClaw to an Existing Codex Session (ACP Resume UX)

- **Author:** Cortana
- **Date:** 2026-03-27
- **Status:** Draft v1
- **Target repo reviewed:** `openclaw/openclaw` (local clone at `tmp/openclaw-src`, HEAD `953a438`)

---

## 1) Executive Summary

This capability is **already supported at the runtime/tool level** via `sessions_spawn` + `runtime: "acp"` + `resumeSessionId`.

What’s missing is the product UX for normal users: a clear “attach to existing Codex session” path in natural language and slash-command ergonomics, plus stronger validation/error guidance.

This PRD proposes shipping a first-class **Attach/Resume ACP Session** flow so users can reliably continue an existing Codex session from OpenClaw without manual spelunking.

---

## 2) Problem Statement

Users run Codex sessions outside OpenClaw (CLI, laptop, prior sessions) and want OpenClaw to continue those exact sessions.

Current friction:
- Users don’t know the feature exists.
- `resumeSessionId` is hidden behind low-level tool usage.
- No friendly command alias like `/acp resume ...`.
- Error handling is technical (session id invalid/not found/capability mismatch).

Result: users assume it’s impossible or brittle.

---

## 3) Evidence from Codebase (validated)

### Already implemented
1. `sessions_spawn` schema includes `resumeSessionId` with ACP-only semantics.
   - File: `src/agents/tools/sessions-spawn-tool.ts`
2. Tool validates ACP-only usage:
   - returns error if `resumeSessionId` used with non-ACP runtime.
3. ACP runtime bridges resume into backend session creation.
   - File: `extensions/acpx/src/runtime.ts`
   - Uses `acpx sessions new --resume-session <id>`
4. ACP control-plane forwards/handles `resumeSessionId` during ensure/init.
   - File: `src/acp/control-plane/manager.core.ts`
5. Docs explicitly describe this flow.
   - File: `docs/tools/acp-agents.md` (Resume an existing session)
6. Changelog confirms feature landed.
   - File: `CHANGELOG.md` entry: ACP/sessions_spawn optional `resumeSessionId`.

### Conclusion
Runtime support exists. UX and discoverability are the real gap.

---

## 4) Product Goals

1. Make “connect OpenClaw to existing Codex session” obvious and one-step.
2. Preserve existing safety/policy controls (`acp.allowedAgents`, sandbox guardrails).
3. Provide deterministic, human-readable errors and recovery guidance.
4. Keep backward compatibility with existing `sessions_spawn` behavior.

---

## 5) Non-Goals

- No changes to ACP protocol spec itself.
- No cross-provider session translation (Codex ↔ Claude, etc.).
- No bypass of runtime/security policy.

---

## 6) Proposed Product/UX

### 6.1 Slash command: `/acp resume`
Add:
- `/acp resume <agent> <resumeSessionId> [--thread auto|here|off] [--mode persistent|oneshot] [--cwd <path>] [--label <name>]`

Behavior:
- Internally maps to `sessions_spawn({ runtime:"acp", agentId, resumeSessionId, ... })`.
- Response confirms:
  - target agent
  - provided resume session id
  - resulting OpenClaw `childSessionKey`
  - thread binding outcome

### 6.2 Natural language extraction
When user says:
- “connect to my existing codex session <id>”
- “resume codex session <id>”

Router should infer ACP resume intent and call ACP spawn with `resumeSessionId`.

### 6.3 Status/readability
`/acp status` should include:
- `resumeSourceSessionId` (if resumed)
- `resumedAt`
- whether session history replay succeeded (`session/load` outcome)

---

## 7) Functional Requirements

FR-1: ACP resume must require `runtime:"acp"` and reject otherwise (already true).

FR-2: Agent must be validated against `acp.allowedAgents` (existing policy).

FR-3: If upstream session id is invalid/not found, return actionable error:
- include attempted id
- include likely fix (check local harness session list)
- no silent fallback unless explicitly requested by user

FR-4: `thread`/`mode` semantics remain unchanged when resuming.

FR-5: Telemetry event emitted for resume attempts:
- success/failure code
- agentId
- channel
- duration

FR-6: Docs + examples updated in:
- `docs/tools/acp-agents.md`
- `docs/tools/slash-commands.md`
- `docs/help/faq.md`

---

## 8) UX Error Contract

Standardized user-facing errors:
1. `ACP_RESUME_NOT_FOUND`
2. `ACP_RESUME_UNSUPPORTED_BY_AGENT` (agent lacks `session/load`)
3. `ACP_RESUME_DENIED_BY_POLICY` (`acp.allowedAgents`/tool policy)
4. `ACP_RESUME_SANDBOX_BLOCKED`

Each error should include a one-line next step.

---

## 9) Security & Policy

- Keep existing ACP sandbox boundary protections.
- No automatic escalation of tool rights.
- Respect per-agent and gateway tool policies.
- Redact sensitive resume IDs in logs where required by policy.

---

## 10) Implementation Plan

### Phase 1 (Quick Win)
- Add `/acp resume` command handler mapping to existing spawn resume path.
- Add NL intent mapping for “resume/connect existing codex session”.
- Improve error strings.

### Phase 2 (Polish)
- Add resume metadata to `/acp status`.
- Add observability counters and dashboard hooks.
- Add FAQ + docs screenshots/examples.

---

## 11) Testing Plan

### Unit
- Command parser for `/acp resume` permutations.
- Intent extraction for NL resume requests.
- Error mapping coverage.

### Integration
- Resume valid Codex session id.
- Resume invalid id returns deterministic error.
- Resume blocked by `acp.allowedAgents`.
- Resume from thread and non-thread contexts.

### Regression
- Existing `/acp spawn` unaffected.
- Existing `sessions_spawn` ACP and subagent paths unaffected.

---

## 12) Success Metrics

- ≥80% of resume requests complete without manual intervention.
- <5% ambiguous/failed resume attempts due to UX confusion.
- Reduced support queries about “can OpenClaw connect to my existing Codex session?”.

---

## 13) Open Questions

1. Should `/acp sessions` expose resumable IDs in a copy-friendly format by default?
2. Should we allow an explicit `--fallback-new` option when resume fails?
3. Do we need per-channel formatting differences for session-id display/copy?

---

## 14) Direct Answer to User Ask

Yes — this is possible today via:

```json
{
  "task": "continue from current stopping point",
  "runtime": "acp",
  "agentId": "codex",
  "resumeSessionId": "<codex-session-id>"
}
```

This PRD focuses on making that workflow first-class and painless.
