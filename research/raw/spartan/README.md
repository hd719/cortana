# Spartan Raw Research Corpus

This directory is the raw research intake for the Spartan fitness project.

In the LLM wiki workflow:
- `pdfs/` holds the original source corpus
- [corpus-inventory.md](./corpus-inventory.md) is the human/LLM-readable index for that corpus
- `research/derived/spartan/` is where synthesis artifacts should be written
- `knowledge/` should only be updated after durable conclusions emerge from the derived layer

## Current Corpus

- primary source set: `pdfs/`
- scope: athletic performance, hypertrophy, strength, conditioning, nutrition, recovery, fatigue, and velocity-based training
- current intake style: mixed publisher filenames plus several better human-readable exports

## Working Rules

- Keep new source papers in `pdfs/` unless there is a strong reason to add a different raw format.
- Do not treat filenames as canonical titles. Use the normalized title in [corpus-inventory.md](./corpus-inventory.md).
- Add notes, clipping summaries, or extraction artifacts only if they materially help later synthesis.
- Do not promote claims directly from raw PDFs into `knowledge/` without first writing a derived synthesis artifact.

## Recommended Next Moves

1. Use [corpus-inventory.md](./corpus-inventory.md) as the lookup table for future LLM research passes.
2. Write topic syntheses into:
   - [strength-hypertrophy-and-progression.md](/Users/hd/Developer/cortana/research/derived/spartan/strength-hypertrophy-and-progression.md)
   - [recovery-readiness-and-fatigue.md](/Users/hd/Developer/cortana/research/derived/spartan/recovery-readiness-and-fatigue.md)
   - [nutrition-and-body-composition.md](/Users/hd/Developer/cortana/research/derived/spartan/nutrition-and-body-composition.md)
   - [conditioning-and-athletic-performance.md](/Users/hd/Developer/cortana/research/derived/spartan/conditioning-and-athletic-performance.md)
   - [velocity-based-training-and-autoregulation.md](/Users/hd/Developer/cortana/research/derived/spartan/velocity-based-training-and-autoregulation.md)
3. Consolidate durable findings later into Spartan knowledge pages once those pages exist.
