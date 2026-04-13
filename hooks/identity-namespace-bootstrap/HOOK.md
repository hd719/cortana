---
name: identity-namespace-bootstrap
description: "Per-agent identity namespace override for bootstrap context files"
metadata:
  {
    "openclaw":
      {
        "emoji": "🧬",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] }
      }
  }
---

# identity-namespace-bootstrap

Replaces SOUL/USER/IDENTITY/VOICE/HEARTBEAT/MEMORY bootstrap files with per-agent namespace variants from:

- `identities/<namespace>/SOUL.md`
- `identities/<namespace>/USER.md`
- `identities/<namespace>/IDENTITY.md`
- `identities/<namespace>/VOICE.md`
- `identities/<namespace>/HEARTBEAT.md`
- `identities/<namespace>/MEMORY.md`

Also adds dynamic bootstrap context when available:

- `AGENT_FEEDBACK.md` generated from active `cortana_agent_feedback` lessons for the current agent role plus `all`
- generation is non-blocking; bootstrap continues without it if the query fails

Config (in `hooks.internal.entries.identity-namespace-bootstrap`):

- `configPath` (default: `config/identity-namespaces.json`)
