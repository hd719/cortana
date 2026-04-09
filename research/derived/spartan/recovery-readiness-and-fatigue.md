# Recovery, Readiness, And Fatigue

This summary groups the papers most relevant to Spartan's day-to-day readiness logic and recovery guardrails.

## Why This Bucket Matters For Spartan

Spartan already makes daily recommendation calls based on recovery and data trust. This bucket should improve:
- push / maintain / pullback mode selection
- confidence degradation under poor recovery or stale evidence
- soreness, fatigue, and mental-fatigue interpretation
- recovery-risk and overreach alert quality

## Source Buckets Included

- recovery
- readiness-fatigue
- sleep
- selected conditioning and nutrition papers when recovery adaptation is central

## Main Questions To Answer

- Which signals should most strongly lower confidence or clamp training mode?
- How should mental fatigue and perceived effort influence tomorrow-session planning?
- Which recovery interventions are actually worth reflecting in policy versus just noting?
- When is the right answer a training adjustment vs a simple warning or caveat?

## Best-Supported Findings

### Mental Fatigue Should Not Auto-Cancel Training Quality

- The crossover study in [European Journal of Sport Science - 2024 - Romagnoli - Can mental fatigue affect perception of barbell velocity in.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/European%20Journal%20of%20Sport%20Science%20-%202024%20-%20Romagnoli%20-%20Can%20mental%20fatigue%20affect%20perception%20of%20barbell%20velocity%20in.pdf) increased mental fatigue and lowered motivation, but it did not meaningfully reduce actual bar velocity, velocity perception, or `RPE` accuracy in the tested squat loads.

Spartan implication:
- A bad mental state should lower confidence, but it should not automatically force a pullback if warm-up performance and actual session execution still look normal.

### Recovery Tools Are Outcome-Specific, Not Universal

- The ischemic conditioning study in [BS_Art_55026-10.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/BS_Art_55026-10.pdf) showed mixed results depending on the outcome measured:
  - post-exercise ischemic conditioning preserved jump output better than pre-exercise use
  - stretching plus foam rolling restored lower-extremity strength faster
  - biomarker patterns slightly favored ischemic conditioning in some cases
- The cold-water immersion study in [ijerph-22-00122.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/ijerph-22-00122.pdf) improved isometric force recovery by `48h`, but did not show a clean universal biomarker advantage.

Spartan implication:
- Recovery interventions should be optional tools tied to a clear goal like next-session force output, not default habits applied after every workout.

### Readiness Estimation Should Use Dual Signals

- The comparison study in [TheEffectsOfPercentagebasedRatingOfPerceivedExertionRepetitionsInReserveAndVelocitybasedTrainingOnPerformanceAndFatigueResponsesAM-OWEN.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/TheEffectsOfPercentagebasedRatingOfPerceivedExertionRepetitionsInReserveAndVelocitybasedTrainingOnPerformanceAndFatigueResponsesAM-OWEN.pdf) found that `RIR` and `VBT` preserved volume better than `%1RM`, while fatigue at `24h` was not meaningfully worse.
- The large observational study in [peerj-19797.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/peerj-19797.pdf) showed that velocity and perceived reps-in-reserve are related, but the same speed can mean different things depending on exercise, load, set number, and fatigue context.

Spartan implication:
- Spartan should use subjective and performance signals together.
- One universal mapping from speed to effort is too brittle.

### Conditioning Should Not Default To Moderate Work

- The conditioning trial in [European Journal of Sport Science - 2024 - Hov - Aerobic high‐intensity interval training and maximal strength training in.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/European%20Journal%20of%20Sport%20Science%20-%202024%20-%20Hov%20-%20Aerobic%20high%E2%80%90intensity%20interval%20training%20and%20maximal%20strength%20training%20in.pdf) favored deliberate `HIIT` plus maximal-strength work over moderate training for both `VO2peak` and strength in that population.

Spartan implication:
- When readiness and pain allow, Spartan should not treat moderate training as the default safe answer.

## Practical Spartan Rules To Test

1. Separate `low confidence` from `low readiness`; they often overlap but are not identical.
2. Do not downgrade a session from self-reported mental fatigue alone if warm-up performance is still intact.
3. Use recovery interventions only when they are tied to a concrete next-session need such as force output or soreness management.
4. Use `RIR` and performance trends as default readiness tools, and treat velocity as an additional signal when available.
5. Keep alerting conservative and pattern-based rather than reacting to one noisy bad day.

## Confidence

- Higher confidence:
  - mental fatigue alone is not enough to infer poor session execution
  - recovery methods have context-dependent rather than universal benefit
  - rigid `%1RM` logic is weaker than readiness-aware logic
- Moderate confidence:
  - cold-water immersion can help short-term force recovery
  - post-session ischemic conditioning may help in narrow cases
- Lower confidence:
  - sleep-specific decision rules from this corpus alone
  - biomarker-heavy recovery policies

## Likely Spartan Surfaces To Update Later

- daily training-mode clamps
- recovery-risk alerts
- operator explanations around soreness, fatigue debt, and confidence
- weekly deload or reduced-dose logic

## Strong Candidate Source Papers

- Can Mental Fatigue Affect Perception of Barbell Velocity in Resistance Training?
- The Effects of Percentage-Based, RPE, Repetitions in Reserve, and Velocity-Based Training on Performance and Fatigue Responses
- Exercise Type, Training Load, Velocity Loss Threshold, and Sets Affect the Relationship Between Lifting Velocity and Perceived Repetitions in Reserve
- The Effects of Different Ischemic Conditioning on Strength Training Recovery
- Enhancing Post-Training Muscle Recovery and Strength with Cold-Water Immersion

## Candidate Promotion Targets

- daily training-mode clamps
- recovery-risk alerts
- explanation rules around fatigue, soreness, and confidence
