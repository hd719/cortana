# OpenClaw Runtime Tools

## Memory Wiki Sync

Refresh the isolated OpenClaw `memory-wiki` vault from the canonical docs in `cortana` and `cortana-external`.

Script:

```bash
/Users/hd/Developer/cortana/tools/openclaw/sync-memory-wiki.sh
```

What it does:

- ingests a small curated set of repo-native source docs
- refreshes the wiki syntheses:
  - `Cortana Repo Topology`
  - `Cortana Documentation Topology`
- recompiles the isolated wiki vault so Dreaming can read the latest pages

Scope:

- `cortana/README.md`
- `cortana/docs/README.md`
- `cortana/knowledge/indexes/systems.md`
- `cortana-external/README.md`
- `cortana-external/docs/README.md`
- `cortana-external/knowledge/indexes/systems.md`

Notes:

- This is an operator sync, not a broad crawler.
- It keeps the wiki aligned with curated source docs without importing private chat exports.
- Runtime wiki state stays under `~/.openclaw/wiki/cortana`; it does not write tracked repo memory.
