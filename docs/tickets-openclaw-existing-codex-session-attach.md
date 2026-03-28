# Tickets — OpenClaw Existing Codex Session Attach

## Epic summary

Ship a first-class ACP resume flow in OpenClaw so users can attach to an existing Codex session through normal product UX instead of low-level `sessions_spawn` usage. Runtime support already exists; this epic covers discoverability, command ergonomics, validation, status visibility, telemetry, and docs.

## Ticket list

- `T1` Slash command support for `/acp resume`
- `T2` Natural-language intent routing for ACP resume
- `T3` Standardized ACP resume validation and error contract
- `T4` Resume metadata in ACP status surfaces
- `T5` Resume telemetry and observability hooks
- `T6` Documentation and FAQ refresh

## Milestones

### Phase 1 quick win

- `T1` Slash command support for `/acp resume`
- `T2` Natural-language intent routing for ACP resume
- `T3` Standardized ACP resume validation and error contract
- `T6` Documentation and FAQ refresh

### Phase 2 polish

- `T4` Resume metadata in ACP status surfaces
- `T5` Resume telemetry and observability hooks
- Extend `T6` with screenshots/examples if UX assets exist

## Tickets

### T1. Add `/acp resume` slash command

- Owner suggestion: OpenClaw app/runtime engineer
- Scope: Add command parsing and handler support for `/acp resume <agent> <resumeSessionId> [--thread auto|here|off] [--mode persistent|oneshot] [--cwd <path>] [--label <name>]`, mapping directly to `sessions_spawn` with `runtime:"acp"` and `resumeSessionId`.
- Acceptance criteria:
  - Command parser accepts the documented argument shape and rejects malformed input with help text.
  - Handler calls the existing ACP spawn path without changing current `thread` or `mode` semantics.
  - Success response includes agent, attempted resume session id, resulting `childSessionKey`, and thread-binding outcome.
  - Existing `/acp spawn` behavior remains unchanged.
- Dependencies: none
- Estimate: `M`
- Risk notes: Parser work can drift into command-framework cleanup; keep this scoped to the new command path.

### T2. Add natural-language resume intent routing

- Owner suggestion: Router/orchestration engineer
- Scope: Teach NL routing to recognize requests like “connect to my existing codex session <id>” and “resume codex session <id>”, then dispatch the ACP resume path with the extracted session id and target agent.
- Acceptance criteria:
  - Router recognizes explicit resume/attach phrasing for Codex session continuation.
  - Session id extraction works for expected user phrasings and does not silently fall back to a fresh session on parse failure.
  - Ambiguous requests return a clarifying or corrective response instead of taking the wrong action.
  - Threaded and non-threaded entry points both preserve current semantics.
- Dependencies: `T1`
- Estimate: `M`
- Risk notes: Intent matching can over-trigger on generic “resume session” wording; bias toward explicit Codex/ACP language first.

### T3. Standardize ACP resume validation and user-facing errors

- Owner suggestion: ACP/runtime engineer
- Scope: Centralize resume-specific validation and map failures to a stable UX error contract for not found, unsupported agent capability, policy denial, and sandbox blocking.
- Acceptance criteria:
  - Resume remains ACP-only and rejects non-ACP runtime usage deterministically.
  - Allowed-agent and tool-policy checks surface a clear deny message.
  - Invalid or missing upstream session ids return actionable guidance including attempted id and likely next step.
  - User-facing errors are standardized to:
    - `ACP_RESUME_NOT_FOUND`
    - `ACP_RESUME_UNSUPPORTED_BY_AGENT`
    - `ACP_RESUME_DENIED_BY_POLICY`
    - `ACP_RESUME_SANDBOX_BLOCKED`
  - No silent fallback to creating a new session unless a future explicit fallback option is introduced.
- Dependencies: none
- Estimate: `M`
- Risk notes: Error mapping may span multiple layers; avoid duplicating partially inconsistent messages across command, router, and runtime boundaries.

### T4. Expose resume metadata in `/acp status`

- Owner suggestion: ACP/status surface engineer
- Scope: Add resume-aware status fields so users can confirm whether a session was attached from an upstream Codex session and whether history replay/load succeeded.
- Acceptance criteria:
  - `/acp status` includes `resumeSourceSessionId` when applicable.
  - `/acp status` includes `resumedAt`.
  - Status output includes session-history replay or `session/load` outcome in readable form.
  - Non-resumed sessions keep clean status output without confusing null/noise fields.
- Dependencies: `T1`, `T3`
- Estimate: `S`
- Risk notes: Status schema changes can affect downstream consumers or tests if output shape is assumed elsewhere.

### T5. Add telemetry for ACP resume attempts

- Owner suggestion: Observability/platform engineer
- Scope: Emit structured telemetry for resume attempts and outcomes so the team can track adoption, failure modes, and latency.
- Acceptance criteria:
  - Resume attempt events capture success/failure code, `agentId`, channel, and duration.
  - Failure telemetry uses the standardized error codes from `T3`.
  - Instrumentation distinguishes resume flows from normal ACP spawn flows.
  - Metrics are available for dashboarding or counter-based monitoring.
- Dependencies: `T3`
- Estimate: `S`
- Risk notes: Event naming should be settled early to avoid post-launch metric fragmentation.

### T6. Refresh docs, examples, and FAQ

- Owner suggestion: Docs engineer or feature owner
- Scope: Update product docs to make the existing-session attach path obvious, including slash-command examples, NL examples, troubleshooting, and policy caveats.
- Acceptance criteria:
  - `docs/tools/acp-agents.md` documents the first-class resume flow.
  - `docs/tools/slash-commands.md` includes `/acp resume` syntax and examples.
  - `docs/help/faq.md` answers whether OpenClaw can connect to an existing Codex session and how to recover from common failures.
  - Docs reflect the final user-facing error strings and expected next steps.
- Dependencies: `T1`, `T3`
- Estimate: `S`
- Risk notes: Documentation written before final error wording lands will drift; update after API/UX strings are stable.

## Execution order

Critical path: `T3` -> `T1` -> `T2` -> `T6`

- Start with `T3` so validation rules and error codes are fixed before UX surfaces multiply.
- Build `T1` next because slash-command support is the shortest path to user-visible value.
- Layer `T2` after the command path exists so NL routing reuses the same implementation path.
- Land `T6` once command behavior and error wording are stable.
- Run `T4` and `T5` in parallel after the core resume path is implemented.
