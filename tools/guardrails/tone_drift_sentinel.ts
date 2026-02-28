#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import { getScriptDir } from "../lib/paths.js";

type Flag = {
  code: string;
  severity: number;
  message: string;
};

const FIXTURES_PATH = path.join(getScriptDir(import.meta.url), "tone_drift_fixtures.json");

const HEART_EMOJI_RE = /[\u2764\u2665\u{1F90D}-\u{1F90F}\u{1F493}-\u{1F49F}\u{1F5A4}\u{1FA75}\u{1FA76}]/u;

const FILLER_OPENINGS = [
  "^\\s*great question[\\s,!.]*",
  "^\\s*happy to help[\\s,!.]*",
  "^\\s*absolutely[\\s,!.]*",
  "^\\s*certainly[\\s,!.]*",
  "^\\s*thanks for asking[\\s,!.]*",
];

const ROBOTIC_PATTERNS = [
  "\\bas an ai\\b",
  "\\bi cannot\\b",
  "\\bi am unable to\\b",
  "\\bplease let me know if you have any further questions\\b",
  "\\bin conclusion\\b",
  "\\bhere(?:'s| is) a (?:summary|breakdown)\\b",
  "\\bfirst,\\s+second,\\s+third\\b",
];

const WARMTH_MARKERS = new Set(["you", "we", "us", "let's", "nice", "solid", "good", "proud", "got this", "on it"]);

const WIT_MARKERS = new Set(["plot twist", "clean kill", "spicy", "wild", "brutal", "ship it", "hot mess", "weird", "nope"]);

const PERSONALITY_MARKERS = new Set([
  "recommend",
  "do this",
  "skip",
  "instead",
  "chief",
  "on it",
  "course correction",
  "this breaks",
]);

const VAGUE_OPENINGS = ["^\\s*hello[\\s,!.]*", "^\\s*hi there[\\s,!.]*"];

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function containsAny(text: string, patterns: string[]): boolean {
  return patterns.some((p) => new RegExp(p, "i").test(text));
}

function scoreReply(text: string): Record<string, unknown> {
  const normalized = normalize(text);
  const flags: Flag[] = [];
  let score = 1.0;

  const penalize = (code: string, severity: number, message: string) => {
    flags.push({ code, severity, message });
    score -= severity;
  };

  if (!normalized) {
    penalize("empty_reply", 0.9, "Reply is empty.");
  }

  if (HEART_EMOJI_RE.test(text)) {
    penalize("banned_heart_emoji", 0.6, "Heart emoji detected (policy ban).");
  }

  if (containsAny(normalized, FILLER_OPENINGS)) {
    penalize("filler_opening", 0.25, "Reply opens with filler phrase.");
  }

  if (containsAny(normalized, VAGUE_OPENINGS)) {
    penalize("weak_opening", 0.1, "Opening is generic instead of answer-first.");
  }

  if (containsAny(normalized, ROBOTIC_PATTERNS)) {
    penalize("robotic_phrase", 0.35, "Robotic/transactional phrase detected.");
  }

  if (normalized.split(" ").filter(Boolean).length > 120) {
    penalize("too_verbose_default", 0.15, "Reply is verbose; default style should be brief.");
  }

  if (normalized.slice(0, 90).includes("?")) {
    penalize("question_first", 0.1, "Reply likely opens with a question, not an answer.");
  }

  const warmthHits = [...WARMTH_MARKERS].filter((m) => normalized.includes(m)).length;
  const witHits = [...WIT_MARKERS].filter((m) => normalized.includes(m)).length;
  const personalityHits = [...PERSONALITY_MARKERS].filter((m) => normalized.includes(m)).length;

  const warmthScore = Math.min(1.0, warmthHits / 2);
  const witScore = Math.min(1.0, witHits / 1);
  const personalityScore = Math.min(1.0, personalityHits / 2);

  if (warmthScore < 0.2) {
    penalize("low_warmth", 0.12, "Low warmth/presence signal.");
  }
  if (witScore < 0.1) {
    penalize("low_wit", 0.08, "No wit/playful signal detected.");
  }
  if (personalityScore < 0.2) {
    penalize("low_personality", 0.12, "Weak recommendation/personality signature.");
  }

  score = Math.max(0.0, Math.min(1.0, score));

  return {
    score: Number(score.toFixed(4)),
    dimensions: {
      warmth: Number(warmthScore.toFixed(4)),
      wit: Number(witScore.toFixed(4)),
      personality_presence: Number(personalityScore.toFixed(4)),
    },
    flags: flags.map((f) => ({ ...f })),
    reply_length: text.length,
    word_count: normalized ? normalized.split(" ").filter(Boolean).length : 0,
    pass: score >= 0.7 && !flags.some((f) => f.code === "banned_heart_emoji"),
  };
}

function emit(event: string, payload: Record<string, unknown>, pretty: boolean): void {
  const out = { event, ...payload };
  if (pretty) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(JSON.stringify(out));
  }
}

function runFixtures(pretty: boolean): number {
  const raw = fs.readFileSync(FIXTURES_PATH, "utf8");
  const fixtures = JSON.parse(raw) as Record<string, Array<Record<string, any>>>;
  let passed = 0;
  let total = 0;

  for (const [groupName, tests] of Object.entries(fixtures)) {
    for (const test of tests) {
      total += 1;
      const result = scoreReply(String(test.text ?? "")) as Record<string, any>;

      const expectedMin = Number(test.expected_min_score ?? 0.0);
      const expectedMax = Number(test.expected_max_score ?? 1.0);
      const expectedFlags = new Set<string>(test.expected_flags ?? []);
      const actualFlags = new Set<string>((result.flags ?? []).map((f: any) => f.code));

      const ok =
        result.score >= expectedMin &&
        result.score <= expectedMax &&
        [...expectedFlags].every((f) => actualFlags.has(f));
      if (ok) passed += 1;

      emit(
        "tone_fixture_result",
        {
          group: groupName,
          name: test.name,
          ok,
          expected_min_score: expectedMin,
          expected_max_score: expectedMax,
          actual_score: result.score,
          expected_flags: [...expectedFlags].sort(),
          actual_flags: [...actualFlags].sort(),
        },
        pretty,
      );
    }
  }

  emit("tone_fixture_summary", { passed, total, success: passed === total }, pretty);
  return passed === total ? 0 : 1;
}

function parseArgs(argv: string[]): {
  text: string | null;
  file: string | null;
  runFixtures: boolean;
  pretty: boolean;
} {
  const args = {
    text: null as string | null,
    file: null as string | null,
    runFixtures: false,
    pretty: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--text") {
      args.text = argv[++i] ?? null;
    } else if (a === "--file") {
      args.file = argv[++i] ?? null;
    } else if (a === "--run-fixtures") {
      args.runFixtures = true;
    } else if (a === "--pretty") {
      args.pretty = true;
    }
  }

  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.runFixtures) {
    return runFixtures(args.pretty);
  }

  if (!args.text && !args.file) {
    console.error("Provide --text or --file (or --run-fixtures).");
    return 2;
  }

  const text = args.text ?? fs.readFileSync(args.file as string, "utf8");
  const result = scoreReply(text);
  emit("tone_drift_decision", result as Record<string, unknown>, args.pretty);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
