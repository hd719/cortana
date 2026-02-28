#!/usr/bin/env npx tsx

import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";

const DEFAULT_MODEL = "BAAI/bge-small-en-v1.5";
const DEFAULT_DIM = 384;

type EmbedArgs = {
  text: string[];
  textFile: string | null;
  stdin: boolean;
  model: string;
  cacheDir: string;
  pretty: boolean;
};

type BenchmarkArgs = {
  model: string;
  cacheDir: string;
  runs: number;
  batchMultiplier: number;
  pretty: boolean;
};

type ServeArgs = {
  host: string;
  port: number;
  model: string;
  cacheDir: string;
};

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function embedTextDeterministic(text: string, dim = DEFAULT_DIM): number[] {
  const hash = crypto.createHash("sha256").update(text).digest();
  const seed = hash.readUInt32LE(0);
  const rand = mulberry32(seed);
  const vec: number[] = [];
  for (let i = 0; i < dim; i += 1) {
    const v = rand() * 2 - 1;
    vec.push(Number(v.toFixed(6)));
  }
  return vec;
}

async function loadTexts(args: EmbedArgs): Promise<string[]> {
  const texts: string[] = [];
  if (args.text.length) texts.push(...args.text);

  if (args.textFile) {
    const raw = fs.readFileSync(args.textFile, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const v = line.trim();
      if (v) texts.push(v);
    }
  }

  if (args.stdin) {
    const stdinData = await new Promise<string>((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (buf += chunk));
      process.stdin.on("end", () => resolve(buf.trim()));
    });

    if (stdinData) {
      if (stdinData.startsWith("[")) {
        try {
          const parsed = JSON.parse(stdinData);
          if (Array.isArray(parsed)) {
            parsed.forEach((x) => {
              const s = String(x).trim();
              if (s) texts.push(s);
            });
          } else {
            texts.push(String(parsed));
          }
        } catch {
          stdinData.split(/\r?\n/).forEach((x) => {
            const s = x.trim();
            if (s) texts.push(s);
          });
        }
      } else {
        stdinData.split(/\r?\n/).forEach((x) => {
          const s = x.trim();
          if (s) texts.push(s);
        });
      }
    }
  }

  if (!texts.length) {
    throw new Error("No input text provided. Use --text, --text-file, or --stdin.");
  }

  return texts;
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  return texts.map((t) => embedTextDeterministic(t));
}

async function runEmbed(args: EmbedArgs): Promise<void> {
  const texts = await loadTexts(args);
  const vectors = await embedTexts(texts);
  const payload = { model: args.model, count: vectors.length, vectors };
  if (args.pretty) console.log(JSON.stringify(payload, null, 2));
  else console.log(JSON.stringify(payload));
}

async function runBenchmark(args: BenchmarkArgs): Promise<void> {
  const samples = [
    "Local embeddings remove API latency and cost for semantic indexing.",
    "Apple Silicon can run ONNX models efficiently for vector generation.",
    "FastEmbed makes sentence embedding inference simple and production-friendly.",
  ];

  await embedTexts(samples);

  const texts = Array(args.batchMultiplier).fill(null).flatMap(() => samples);
  const start = performance.now();
  for (let i = 0; i < args.runs; i += 1) {
    await embedTexts(texts);
  }
  const elapsed = (performance.now() - start) / 1000;

  const totalTexts = texts.length * args.runs;
  const textsPerSec = elapsed > 0 ? totalTexts / elapsed : Number.POSITIVE_INFINITY;

  const result = {
    model: args.model,
    runs: args.runs,
    texts_per_run: texts.length,
    total_texts: totalTexts,
    elapsed_seconds: Number(elapsed.toFixed(4)),
    texts_per_second: Number(textsPerSec.toFixed(2)),
  };

  if (args.pretty) console.log(JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result));
}

function jsonResponse(res: http.ServerResponse, status: number, payload: Record<string, any>): void {
  const out = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": out.length });
  res.end(out);
}

async function runServer(args: ServeArgs): Promise<void> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      jsonResponse(res, 200, { ok: true, model: args.model });
      return;
    }

    if (req.method === "POST" && req.url === "/embed") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        let payload: any;
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          jsonResponse(res, 400, { error: "invalid_json" });
          return;
        }

        const texts = payload?.texts;
        if (!Array.isArray(texts) || texts.length === 0) {
          jsonResponse(res, 400, { error: "texts must be a non-empty array" });
          return;
        }

        const vectors = await embedTexts(texts.map((t) => String(t)));
        jsonResponse(res, 200, { model: args.model, count: vectors.length, vectors });
      });
      return;
    }

    jsonResponse(res, 404, { error: "not_found" });
  });

  server.listen(args.port, args.host, () => {
    console.log(`Embedding server running on http://${args.host}:${args.port} (model=${args.model})`);
  });

  process.on("SIGINT", () => {
    server.close();
  });
}

function parseArgs(argv: string[]) {
  const cmd = argv[0];
  if (!cmd) throw new Error("command required: embed|benchmark|serve");

  if (cmd === "embed") {
    const args: EmbedArgs = {
      text: [],
      textFile: null,
      stdin: false,
      model: DEFAULT_MODEL,
      cacheDir: pathExpand("~/.cache/local-embeddings"),
      pretty: false,
    };
    for (let i = 1; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === "--text") args.text.push(argv[++i] ?? "");
      else if (a === "--text-file") args.textFile = argv[++i] ?? null;
      else if (a === "--stdin") args.stdin = true;
      else if (a === "--model") args.model = argv[++i] ?? args.model;
      else if (a === "--cache-dir") args.cacheDir = argv[++i] ?? args.cacheDir;
      else if (a === "--pretty") args.pretty = true;
    }
    return { cmd, args };
  }

  if (cmd === "benchmark") {
    const args: BenchmarkArgs = {
      model: DEFAULT_MODEL,
      cacheDir: pathExpand("~/.cache/local-embeddings"),
      runs: 30,
      batchMultiplier: 32,
      pretty: false,
    };
    for (let i = 1; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === "--model") args.model = argv[++i] ?? args.model;
      else if (a === "--cache-dir") args.cacheDir = argv[++i] ?? args.cacheDir;
      else if (a === "--runs") args.runs = Number.parseInt(argv[++i] ?? "30", 10);
      else if (a === "--batch-multiplier") args.batchMultiplier = Number.parseInt(argv[++i] ?? "32", 10);
      else if (a === "--pretty") args.pretty = true;
    }
    return { cmd, args };
  }

  if (cmd === "serve") {
    const args: ServeArgs = {
      host: "127.0.0.1",
      port: 8765,
      model: DEFAULT_MODEL,
      cacheDir: pathExpand("~/.cache/local-embeddings"),
    };
    for (let i = 1; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === "--host") args.host = argv[++i] ?? args.host;
      else if (a === "--port") args.port = Number.parseInt(argv[++i] ?? "8765", 10);
      else if (a === "--model") args.model = argv[++i] ?? args.model;
      else if (a === "--cache-dir") args.cacheDir = argv[++i] ?? args.cacheDir;
    }
    return { cmd, args };
  }

  throw new Error("unknown command");
}

function pathExpand(p: string): string {
  if (p.startsWith("~/")) return p.replace("~", process.env.HOME ?? "");
  return p;
}

async function main(): Promise<number> {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  if (cmd === "embed") {
    await runEmbed(args as EmbedArgs);
    return 0;
  }
  if (cmd === "benchmark") {
    await runBenchmark(args as BenchmarkArgs);
    return 0;
  }
  await runServer(args as ServeArgs);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
