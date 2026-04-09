# Strength, Hypertrophy, And Progression

This summary groups the papers most relevant to Spartan's core training-intelligence logic.

## Why This Bucket Matters For Spartan

These papers are the best fit for improving:
- weekly muscle-dose logic
- load selection defaults
- exercise-order and set-structure assumptions
- progression vs fatigue tradeoffs
- explanation quality in weekly recommendations

## Source Buckets Included

- hypertrophy
- strength
- selected general-athletic-performance papers that directly inform resistance training outcomes

The full source list is indexed in [corpus-inventory.md](/Users/hd/Developer/cortana/research/raw/spartan/corpus-inventory.md).

## Main Questions To Answer

- What weekly dose range should Spartan treat as underdosed, adequate, or overdosed by muscle group?
- How should Spartan trade off high load vs lower load when the goal is lean-mass retention vs strength expression?
- How much should exercise order, time efficiency, or time-under-tension matter in real decision logic?
- When should progression be expressed as more load, more reps, more quality work, or simply more recovery?

## Best-Supported Findings

### Strength And Hypertrophy Need Different Defaults

The strongest pattern in the current corpus is that strength and hypertrophy should not be programmed as if they were the same objective:

- The large Bayesian meta-analysis in [bjsports-2023-106807.full.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/bjsports-2023-106807.full.pdf) found that all resistance-training prescriptions beat no training, but heavier loading, especially above about `80% 1RM`, ranked best for maximizing strength.
- That same paper suggests hypertrophy is much less load-sensitive than strength when multi-set training is present.
- The high-load vs low-load meta-analysis in [s40279-025-02370-8.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/s40279-025-02370-8.pdf) was inconclusive for non-specific strength, but still leaned toward high load, which supports keeping heavier work for primary strength goals.

Spartan implication:
- Strength blocks should bias toward heavier loading and lower fatigue cost.
- Hypertrophy blocks should focus more on weekly productive volume and execution quality than on one perfect load zone.

### Weekly Dose Matters More Than Frequency By Itself

- The within-subject study in [journal.pone.0276154.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/journal.pone.0276154.pdf) found similar `1RM` and hypertrophy outcomes for `1x/week` versus `3x/week` when weekly volume was equalized.
- Higher frequency looked useful mainly because it distributes more work with less per-session fatigue.

Spartan implication:
- Spartan should prescribe weekly set and workload targets first.
- Session frequency should be chosen based on recovery, schedule, and per-session fatigue tolerance.

### Compound Lifts Do Not Grow Every Target Muscle Equally

- The bench-press intervention in [1-s2.0-S1360859224003899-main.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/1-s2.0-S1360859224003899-main.pdf) showed growth across several upper-body muscles, but not uniformly.
- Pectoralis major responded more strongly than pectoralis minor and triceps, while medial deltoid lagged.

Spartan implication:
- Spartan should not assume one compound movement fully covers all hypertrophy needs.
- Accessory selection should reflect predictable weak-response muscles.

### Autoregulation Is More Defensible Than Rigid Linear Progression

- The autoregulated versus linear study in [Anabolic_myokine_responses_and.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/Anabolic_myokine_responses_and.pdf) favored autoregulated progression for strength and power.
- The integrated autoregulation review in [s00421-025-05709-1.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/s00421-025-05709-1.pdf) argues that low-to-moderate intra-set fatigue is usually better for strength, while moderate-to-high fatigue is more defensible when hypertrophy is the explicit goal.

Spartan implication:
- Progression should be expressed as a goal-aware adjustment system, not a fixed staircase.
- Strength phases should cap fatigue earlier than hypertrophy-focused phases.

## Practical Spartan Rules To Test

1. Set weekly muscle-dose targets before deciding frequency.
2. Keep heavy loading in the plan for strength goals even when hypertrophy work is present.
3. Treat hypertrophy as a multi-set dose problem with broader acceptable load ranges.
4. Add accessory work when compound lifts are unlikely to cover lagging muscles sufficiently.
5. Use readiness-aware progression instead of rigid weekly load jumps.

## Confidence

- Higher confidence:
  - strength needs heavier loading than hypertrophy
  - weekly volume matters more than frequency alone
  - hypertrophy response is not uniform across muscles
- Moderate confidence:
  - exact weekly dose thresholds by muscle group
  - exact fatigue caps by phase
- Lower confidence from this corpus alone:
  - time-under-tension as a primary Spartan control variable
  - one universal progression rule across all athlete states

## Likely Spartan Surfaces To Update Later

- training recommendation defaults
- weekly volume interpretation
- underdosed / overdosed muscle logic
- progression language in operator-facing summaries

## Strong Candidate Source Papers

- Resistance Training Prescription Variables for Muscle Strength and Hypertrophy
- Effect of Different Training Frequencies on Maximal Strength Performance and Muscle Hypertrophy in Trained Individuals
- Non-Specific Strength Changes Between High- and Low-Load Isotonic Resistance Training
- Muscle Hypertrophy Response Across Four Muscles Involved in the Bench Press Exercise
- Comparison of Traditional vs. Lighter Load Strength Training on Fat-Free Mass, Strength, Power and Affective Responses

## Candidate Promotion Targets

- Spartan roadmap assumptions about frequency and volume
- weekly training interpretation logic
- future progression rules in Spartan operator-facing summaries
