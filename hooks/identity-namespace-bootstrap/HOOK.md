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

Replaces SOUL/USER/IDENTITY/HEARTBEAT/MEMORY bootstrap files with per-agent namespace variants from:

- `identities/<namespace>/SOUL.md`
- `identities/<namespace>/USER.md`
- `identities/<namespace>/IDENTITY.md`
- `identities/<namespace>/HEARTBEAT.md`
- `identities/<namespace>/MEMORY.md`

Config (in `hooks.internal.entries.identity-namespace-bootstrap`):

- `configPath` (default: `config/identity-namespaces.json`)
