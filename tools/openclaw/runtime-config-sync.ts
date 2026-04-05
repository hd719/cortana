#!/usr/bin/env npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SOURCE = path.join("/Users/hd/Developer/cortana", "config", "openclaw.json");
const DEFAULT_RUNTIME = path.join(os.homedir(), ".openclaw", "openclaw.json");

type Json = Record<string, any>;

function parseArgs(argv: string[]) {
  const args = { source: DEFAULT_SOURCE, runtime: DEFAULT_RUNTIME, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--source") args.source = argv[++i]!;
    else if (argv[i] === "--runtime") args.runtime = argv[++i]!;
    else if (argv[i] === "--check") args.check = true;
  }
  return args;
}

function readJson(filePath: string): Json {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Json;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function stable(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value === "REDACTED_USE_LIVE_CONFIG" || /^__.*__$/.test(value);
}

function latestBackupCandidates(runtimePath: string): string[] {
  const dir = path.dirname(runtimePath);
  const base = path.basename(runtimePath);
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.bak`))
      .map((name) => path.join(dir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    return [];
  }
}

function firstNonPlaceholder(candidates: Array<unknown>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() && !isPlaceholder(candidate)) return candidate;
  }
  return undefined;
}

function preserveProviderApiKeys(target: Json, sources: Json[]): void {
  const providers = target.models?.providers;
  if (!isObject(providers)) return;
  for (const [provider, cfg] of Object.entries(providers)) {
    if (!isObject(cfg) || !isPlaceholder(cfg.apiKey)) continue;
    const replacement = firstNonPlaceholder(sources.map((src) => src.models?.providers?.[provider]?.apiKey));
    if (replacement) cfg.apiKey = replacement;
  }
}

function preserveTelegramBotTokens(target: Json, sources: Json[]): void {
  const accounts = target.channels?.telegram?.accounts;
  if (!isObject(accounts)) return;
  for (const [accountId, cfg] of Object.entries(accounts)) {
    if (!isObject(cfg) || !isPlaceholder(cfg.botToken)) continue;
    const replacement = firstNonPlaceholder(sources.map((src) => src.channels?.telegram?.accounts?.[accountId]?.botToken));
    if (replacement) cfg.botToken = replacement;
  }
}

function preserveGatewayToken(target: Json, sources: Json[]): void {
  if (!isPlaceholder(target.gateway?.auth?.token)) return;
  const replacement = firstNonPlaceholder(sources.map((src) => src.gateway?.auth?.token));
  if (replacement && isObject(target.gateway?.auth)) target.gateway.auth.token = replacement;
}

export function buildRuntimeConfig(source: Json, secretSources: Json[]): Json {
  const runtime = clone(source);
  preserveProviderApiKeys(runtime, secretSources);
  preserveTelegramBotTokens(runtime, secretSources);
  preserveGatewayToken(runtime, secretSources);
  if (runtime.channels?.telegram && "threadBindings" in runtime.channels.telegram) {
    delete runtime.channels.telegram.threadBindings;
  }
  return runtime;
}

export function syncRuntimeConfig(sourcePath: string, runtimePath: string, check = false): { ok: boolean; changed: boolean } {
  const source = readJson(sourcePath);
  const secretSources = [runtimePath, ...latestBackupCandidates(runtimePath)]
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => readJson(candidate));
  const desired = buildRuntimeConfig(source, secretSources);
  const current = fs.existsSync(runtimePath) ? readJson(runtimePath) : null;
  const changed = !current || stable(current) !== stable(desired);

  if (check) return { ok: !changed, changed };

  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  if (fs.existsSync(runtimePath)) {
    fs.copyFileSync(runtimePath, `${runtimePath}.bak.sync`);
  }
  fs.writeFileSync(runtimePath, `${JSON.stringify(desired, null, 2)}\n`, "utf8");
  return { ok: true, changed };
}

export function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = syncRuntimeConfig(args.source, args.runtime, args.check);
  if (args.check) {
    console.log(result.ok ? "IN_SYNC" : "DRIFT");
    process.exit(result.ok ? 0 : 1);
  }
  console.log(result.changed ? "SYNCED" : "NO_CHANGE");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
