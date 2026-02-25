# Vector Memory Coverage Audit

Date: 2026-02-25
Scope: Task #75 semantic recall verification using OpenClaw memory search (Gemini embeddings, hybrid mode)

## Index health snapshot

From `openclaw memory status --json`:
- Provider: `gemini`
- Model: `gemini-embedding-001`
- Search mode: `hybrid`
- Sources configured: `memory`, `sessions`
- Scanned files:
  - `memory`: 44 files
  - `sessions`: 215 files
- Indexed files/chunks currently in DB:
  - `files: 0`
  - `chunks: 0`

## Query tests run

Queries tested:
1. `sleep patterns REM improvement`
2. `Tonal authentication token fix`
3. `portfolio diversification VXUS`
4. `CANSLIM backtesting results`
5. `Mexico trip Punta Cana`
6. `OpenClaw migration from Clawdbot`

### Results summary

All query attempts were blocked by embedding provider quota exhaustion (`429 RESOURCE_EXHAUSTED` from Gemini).

Observed runtime errors:
- `memory sync failed (session-start): gemini embeddings failed: 429`
- `memory sync failed (search): gemini embeddings failed: 429`
- `Memory search failed: gemini embeddings failed: 429`

Because indexing/search could not complete, retrieval quality could not be validated on semantic results for any test query.

## File-category coverage check

Target categories for audit:
- `MEMORY.md`
- `memory/*.md` (daily/current files)
- `memory/archive/**/*.md`
- `memory/research/*.md`

What we can confirm from current status:
- `memory/*.md`, `memory/archive/**/*.md`, and `memory/research/*.md` are under the `memory` source path and are scanned as files.
- `MEMORY.md` (repo root) is **not explicitly listed** as a source path by the current memory status output (`sources: memory,sessions`), so root-level long-term memory likely has coverage risk unless explicitly indexed elsewhere.
- Effective retrieval coverage is currently **0** because index DB has `files: 0`, `chunks: 0`.

## Sample query quality assessment

| Query | Expected domain | Actual retrieval quality |
|---|---|---|
| sleep patterns REM improvement | Sleep/health history | Blocked (Gemini 429, no results) |
| Tonal authentication token fix | Incident/self-heal playbook | Blocked (Gemini 429, no results) |
| portfolio diversification VXUS | Finance/research notes | Blocked (Gemini 429, no results) |
| CANSLIM backtesting results | Investing research | Blocked (Gemini 429, no results) |
| Mexico trip Punta Cana | Personal travel memory | Blocked (Gemini 429, no results) |
| OpenClaw migration from Clawdbot | Platform migration notes | Blocked (Gemini 429, no results) |

## Gaps found

1. **Critical runtime gap:** Gemini embedding quota exhaustion prevents both indexing and query-time semantic retrieval.
2. **Zero effective index:** Despite scan finding files, index DB currently contains no indexed files/chunks.
3. **Potential source gap:** `MEMORY.md` root file is not explicitly represented in configured sources shown by status output.

## Recommended remediation

1. Restore embeddings quota/access for Gemini provider.
2. Run `openclaw memory index --force` and verify non-zero files/chunks afterward.
3. Re-run the six domain queries and capture top-k results with source paths.
4. Explicitly validate whether `MEMORY.md` is included; if not, add it via memory extra paths/source config.
5. Re-run this audit and update this file with query-to-source evidence once retrieval is functioning.
