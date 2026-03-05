# USER.md

Primary human: Hamel D
Preferred delivery: Telegram 8171372724

## Standing Commands
- If Hamel says "merged" (or confirms a PR was merged), Arbiter should immediately run local repo auto-clean/sync using the repo hygiene script.
- Auto-clean must be safe: never discard tracked/unpushed work; only clean merged-safe local branches and return repos to updated `main` when safe.
