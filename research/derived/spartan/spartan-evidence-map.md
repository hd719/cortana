# Spartan Evidence Map

This file is the top-level synthesis map for the current Spartan paper corpus.

It is a first-pass compilation layer: the goal is to organize the evidence into decision-relevant buckets that match the existing Spartan system shape.

This is closer to a Karpathy-style markdown wiki than a classic RAG system:
- raw source material stays in `research/raw/`
- synthesized working knowledge lives in `research/derived/`
- only durable conclusions should later be promoted into `knowledge/` or planning docs

## Corpus Shape

The current source corpus clusters around:
- hypertrophy and weekly dose
- strength prescription and progression
- recovery and post-training readiness
- nutrition, protein, and body-composition control
- velocity-based training and autoregulation
- conditioning and broad athletic performance support

This maps well to the existing Spartan stack, which already centers:
- data trust before coaching
- readiness-driven daily recommendations
- weekly training intelligence
- Tonal-first programming
- nutrition and body-composition control
- a closed-loop coaching system

## High-Confidence Directional Findings

These are not final production rules yet, but they are the strongest repeated patterns in the current corpus:

- Strength and hypertrophy should not share identical defaults.
  Heavy loading matters more for strength expression, while hypertrophy appears much more tolerant to load variation when weekly multi-set dose is adequate.
- Weekly dose matters more than arbitrary training frequency.
  Frequency is mainly useful as a fatigue-distribution and scheduling tool.
- Autoregulation is more defensible than rigid fixed loading.
  `RIR` and `VBT` both outperform naive `%1RM` logic when readiness shifts across sessions.
- Nutrition should default toward performance support, not trendy restriction.
  High protein, creatine, and lean-mass retention during cuts are better supported than ketogenic dieting for athletic performance.
- Recovery logic should be outcome-specific.
  Fancy recovery methods are situational tools, not universal defaults.
- Athleticism needs dedicated explosive and conditioning work.
  Spartan should not collapse everything into a hypertrophy-only or moderate-cardio-only model.

## Mixed Or Lower-Confidence Areas

- Sleep-specific evidence in the current corpus is weak and should not drive strong Spartan rules yet.
- Specialized recovery interventions like ischemic conditioning and cold exposure are interesting but come from small or narrow populations.
- Velocity-based models are promising, but generalized charts are too crude; they only become strong when individualized and calibrated well.
- Some conditioning evidence is useful but comes from rehab or non-identical populations, so it should be treated as directional.

## High-Value Research Buckets

### Strength, Hypertrophy, And Progression

Best use:
- weekly dose logic
- load selection
- progression rules
- fatigue-aware programming defaults

See:
- [strength-hypertrophy-and-progression.md](./strength-hypertrophy-and-progression.md)

### Recovery, Readiness, And Fatigue

Best use:
- training-mode guardrails
- deload triggers
- daily recommendation confidence
- interpretation of soreness, sleep, and fatigue signals

See:
- [recovery-readiness-and-fatigue.md](./recovery-readiness-and-fatigue.md)

### Nutrition And Body Composition

Best use:
- protein targets
- cut vs maintenance vs lean-gain heuristics
- hydration and diet quality caveats
- lean-mass preservation rules

See:
- [nutrition-and-body-composition.md](./nutrition-and-body-composition.md)

### Conditioning And Athletic Performance

Best use:
- interference rules
- conditioning dose strategy
- general athletic capability framing
- support evidence for broader coaching posture

See:
- [conditioning-and-athletic-performance.md](./conditioning-and-athletic-performance.md)

### Velocity-Based Training And Autoregulation

Best use:
- effort estimation
- volume stop rules
- intensity prescription
- future training recommendation explainability

See:
- [velocity-based-training-and-autoregulation.md](./velocity-based-training-and-autoregulation.md)

## Candidate Spartan Rule Themes

These are the first rule families worth testing against the current Spartan PRD / Tech Spec / implementation docs:

1. Weekly set targets first, frequency second.
2. Heavy loading for strength goals, broader load flexibility for hypertrophy goals.
3. Autoregulate session loading with `RIR` or velocity when possible; avoid rigid `%1RM` as the main daily control.
4. Preserve productive resistance-training volume during cuts to protect lean mass.
5. Default to high-protein, performance-supportive nutrition; treat keto as niche.
6. Use recovery interventions only when tied to a clear next-session goal.
7. Add explicit power / explosiveness support when the goal is athleticism, not only size or strength.

## Best Near-Term Promotion Targets

Once the summaries are tightened further, the most likely promotion targets are:
- `/Users/hd/Developer/cortana/docs/source/planning/spartan/roadmap/fitness-trainer-roadmap-2026-04-04.md`
- `/Users/hd/Developer/cortana/docs/source/planning/spartan/roadmap/spartan-fitness-program-index.md`
- `/Users/hd/Developer/cortana/docs/source/planning/spartan/usage/README.md`
- `/Users/hd/Developer/cortana-external/apps/external-service/knowledge/spartan/overview.md`
- `/Users/hd/Developer/cortana-external/apps/external-service/knowledge/spartan/roadmap.md`

## Current Gaps

- The dedicated Spartan knowledge tree now exists, but it is still a first promotion pass and should continue to be refined against new evidence and live outcomes.
- The raw corpus is strong on training, load, and nutrition, but still relatively light on sleep-specific and recovery-system evidence.
- Some sources are likely exploratory or support evidence rather than direct rule-making inputs.

## Recommended Research Pass Sequence

1. Keep refining the bucket summaries with paper-level notes from the strongest studies.
2. Turn repeated findings into candidate Spartan operating rules with explicit confidence levels.
3. Compare those candidate rules against current Spartan behavior and current roadmap assumptions.
4. Promote only the stable, repeated findings into roadmap, operator, or knowledge pages.
