# Local Embedding Factory: Zero-API Semantic Indexing at Scale

## Overview
This implementation provides **fully local text embeddings** on the Mac mini (Apple Silicon) with no API dependency after initial model download.

- Runtime: Node.js + `tsx` in `~/Developer/cortana/tools/embeddings`
- Engine: `fastembed` (ONNX Runtime)
- Default model: `BAAI/bge-small-en-v1.5` (384-dim vectors)
- Entry points:
  - CLI wrapper: `~/Developer/cortana/tools/embeddings/embed`
  - TypeScript script: `~/Developer/cortana/tools/embeddings/embed.ts`
  - Optional local HTTP service: `embed serve`

## Why this stack
I evaluated practical local options for Apple Silicon:

1. **sentence-transformers + torch (MPS)**
   - Great quality/perf, but currently painful on Python 3.14 due to torch wheel availability.
2. **llama.cpp embeddings**
   - Very good option, but requires GGUF model lifecycle and more bespoke wiring for this task.
3. **fastembed (selected)**
   - Works cleanly on current environment (Python 3.14), optimized ONNX inference, simple API, strong baseline quality.

Given the host environment, **fastembed is the fastest path to production-ready local embeddings**.

## Installed files
- `~/Developer/cortana/tools/embeddings/embed.ts` — embedding CLI + benchmark + HTTP server
- `~/Developer/cortana/tools/embeddings/embed` — wrapper script for local embedding commands

## Setup
```bash
cd ~/Developer/cortana/tools/embeddings
npm install
chmod +x embed.ts embed
```

## Usage
### 1) Embed direct text
```bash
~/Developer/cortana/tools/embeddings/embed embed --text "hello world"
```

### 2) Embed from stdin
```bash
echo "semantic search is local now" | ~/Developer/cortana/tools/embeddings/embed embed --stdin --pretty
```

### 3) Embed from file (one text per line)
```bash
~/Developer/cortana/tools/embeddings/embed embed --text-file ./sentences.txt
```

### 4) Benchmark
```bash
~/openclaw/tools/embeddings/embed benchmark --runs 40 --batch-multiplier 64 --pretty
```

### 5) Run local service
```bash
~/Developer/cortana/tools/embeddings/embed serve --host 127.0.0.1 --port 8765
```

Health check:
```bash
curl -s http://127.0.0.1:8765/health
```

Embed request:
```bash
curl -s -X POST http://127.0.0.1:8765/embed \
  -H 'Content-Type: application/json' \
  -d '{"texts":["semantic search","zero api embeddings"]}'
```

## Benchmark results (Mac mini M-series)
Run command:
```bash
~/openclaw/tools/embeddings/embed benchmark --runs 40 --batch-multiplier 64 --pretty
```

Observed output:
```json
{
  "model": "BAAI/bge-small-en-v1.5",
  "runs": 40,
  "texts_per_run": 192,
  "total_texts": 7680,
  "elapsed_seconds": 5.5598,
  "texts_per_second": 1381.36
}
```

## Integration guidance
For other tools, the easiest integration path is shelling out to the wrapper CLI:

```bash
~/Developer/cortana/tools/embeddings/embed embed --stdin
```

and passing either line-delimited text or JSON array on stdin.

For high-throughput pipelines, run the local server once and call `POST /embed`.

## Notes
- First run downloads model artifacts into `~/.cache/local-embeddings`.
- Subsequent runs are offline/local.
- Output vectors are JSON arrays of floats, ready for pgvector, Qdrant, or similar vector stores.
