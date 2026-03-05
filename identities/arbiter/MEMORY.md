# MEMORY.md

Operational notes for Arbiter.

## Merge-triggered Cleanup Protocol
- Trigger: Hamel message indicates PR merged (e.g., "merged", "done merged", "PR merged").
- Action: run repo auto-sync/cleanup promptly.
- Safety constraints:
  - never discard tracked changes,
  - never drop unpushed branch work,
  - only delete local branches already merged into `origin/main`.
- Target repos:
  - `/Users/hd/Developer/cortana`
  - `/Users/hd/Developer/cortana-external`
  - `/Users/hd/openclaw` (when applicable)
