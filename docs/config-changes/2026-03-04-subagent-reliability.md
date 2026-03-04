# Sub-agent reliability tuning (2026-03-04)

## What changed

The runtime OpenClaw config (`~/.openclaw/openclaw.json`) was tuned to reduce sub-agent aborts:

- `agents.defaults.maxConcurrent`: **4 → 8**
- `agents.defaults.subagents.runTimeoutSeconds`: **added 600**
- `agents.defaults.subagents.archiveAfterMinutes`: **5 → 15**

No full runtime config snapshot is committed in-repo to avoid drift and accidental secret exposure.
Only the targeted tuning values above are recorded.

## Why this changed

Sub-agent runs were intermittently failing with **"Request was aborted"** errors.
Root cause was an effective concurrency ceiling at `maxConcurrent=4`, which caused in-flight requests to be dropped under load. Timeout/archive behavior was also left too implicit/aggressive for longer or bursty runs.

## Expected impact

- Fewer request aborts during parallel sub-agent work
- More predictable run behavior via explicit `runTimeoutSeconds=600`
- Better post-completion visibility/debuggability with longer archive retention (`15` minutes)
