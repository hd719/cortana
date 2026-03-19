# 2026-03-13 ACPX Runtime Fix

## Summary
- Verified ACP/ACPX was enabled, but Codex ACP runs were failing before meaningful work because the runtime was configured too restrictively for non-interactive coding sessions.
- Root cause: `plugins.entries.acpx.config.permissionMode` was set to `approve-reads` while `nonInteractivePermissions` was `fail`.
- Result: Codex ACP sessions could read, but any write/exec permission request in a non-interactive run was blocked, causing stalled/failed coding sessions and stale ACP session records.

## Runtime change applied
- Updated live OpenClaw config at `~/.openclaw/openclaw.json`:
  - `plugins.entries.acpx.config.permissionMode: approve-reads -> approve-all`
- Left `nonInteractivePermissions: fail` unchanged.
- Gateway reloaded successfully after the config patch.

## Why this change
- For non-interactive ACP coding work, `approve-reads` is not enough; Codex needs write/exec capability to modify files, run tests, commit changes, and generally do real work.
- With `approve-all`, ACPX can complete those actions without tripping the non-interactive permission gate for routine coding tasks.

## Follow-up
- Re-test ACP Codex flow end-to-end on a small disposable branch/task.
- If ACP still shows friction, inspect whether any remaining failures come from provider auth, acpx runtime state, or repo-specific command behavior rather than permission policy.
