# Velocity-Based Training And Autoregulation

This summary groups the papers most relevant to effort estimation, autoregulation, and future velocity-aware Spartan logic.

## Why This Bucket Matters For Spartan

This is one of the highest-upside buckets for turning Spartan into a better training-intelligence system.

Potential uses:
- intensity prescription
- volume stop rules
- fatigue-aware session adaptation
- more transparent recommendation explanations
- future Tonal or lift-tracking integrations

## Source Buckets Included

- velocity-based-training
- readiness-fatigue
- selected hypertrophy papers that explicitly compare autoregulated and linear resistance training

## Main Questions To Answer

- Which velocity-derived signals are stable enough for Spartan to trust in practice?
- How should Spartan connect VBT-style evidence to RIR, confidence, and fatigue management?
- When should autoregulation change the session versus simply adjust explanation or confidence?
- Which parts of the VBT literature are usable without direct live bar-speed instrumentation?

## Best-Supported Findings

### Rigid `%1RM` Is Too Brittle For Daily Coaching

- The comparison study in [TheEffectsOfPercentagebasedRatingOfPerceivedExertionRepetitionsInReserveAndVelocitybasedTrainingOnPerformanceAndFatigueResponsesAM-OWEN.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/TheEffectsOfPercentagebasedRatingOfPerceivedExertionRepetitionsInReserveAndVelocitybasedTrainingOnPerformanceAndFatigueResponsesAM-OWEN.pdf) found that `%1RM` often produced lower volume and pushed sets closer to failure than `RIR` or `VBT`.
- `VBT` was the most accurate method in that setup, while `RIR` also preserved session quality better than fixed loading.

Spartan implication:
- Fixed `%1RM` should not be the main daily prescription method when readiness can vary.

### Velocity And `RIR` Are Complementary, Not Interchangeable

- The large real-world study in [peerj-19797.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/peerj-19797.pdf) showed that the relationship between bar velocity and perceived reps in reserve changes by exercise, load, set number, and fatigue context.
- The meta-regression in [s40279-023-01937-7.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/s40279-023-01937-7.pdf) supports the broader point that universal rep and intensity tables are too simplistic.

Spartan implication:
- Spartan should use `RIR` and performance trends as the practical default.
- If velocity is available, it should refine the estimate, not replace all other context.

### Individualized Velocity Models Beat Generic Charts

- The review in [a-2158-3848.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/a-2158-3848.pdf) argues individualized load-velocity relationships are more accurate than generalized ones.
- The free-weight repetition-prediction studies in [1-s2.0-S0031938423000860-main.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/1-s2.0-S0031938423000860-main.pdf) and [1-s2.0-S2405844023068366-main.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/1-s2.0-S2405844023068366-main.pdf) found individualized models fit better, while generalized models and fresh-only calibrations overestimated reps to failure when fatigue rose.

Spartan implication:
- VBT is only strong when calibration is exercise-specific, athlete-specific, and checked against fatigue state.

### Autoregulation Should Be Goal-Aware

- The integrated velocity/autoregulation review in [s00421-025-05709-1.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/s00421-025-05709-1.pdf) argues that lower intra-set fatigue is better when strength and readiness are the priority, while higher fatigue may be acceptable when hypertrophy is the explicit goal.
- The autoregulated training paper in [Anabolic_myokine_responses_and.pdf](/Users/hd/Developer/cortana/research/raw/spartan/pdfs/Anabolic_myokine_responses_and.pdf) also supports the broader case for matching training to day-level capacity.

Spartan implication:
- Autoregulation should not only decide “lighter or heavier today.”
- It should also decide how much fatigue the session is allowed to accumulate.

## Practical Spartan Rules To Test

1. Use goal-driven base prescriptions, then adjust with `RIR`, readiness, and performance trends.
2. Prefer `RIR` as the default fallback when live velocity data is unavailable.
3. If using velocity, calibrate by athlete, exercise, and fatigue context; do not use one global speed table.
4. Cap fatigue lower for strength/readiness blocks and allow higher fatigue only in controlled hypertrophy blocks.
5. Treat VBT as a precision upgrade for trustworthy instrumentation, not as a required dependency for all Spartan logic.

## Confidence

- Higher confidence:
  - fixed `%1RM` is too rigid for fluctuating readiness
  - `RIR` and velocity are useful but not interchangeable
  - individualized velocity models are better than generalized charts
- Moderate confidence:
  - exact calibration methods Spartan should require before trusting VBT outputs
  - exact fatigue-stop thresholds by exercise or phase
- Lower confidence:
  - extending VBT logic too aggressively when instrumentation is unavailable or unreliable

## Likely Spartan Surfaces To Update Later

- effort and fatigue interpretation
- tomorrow-session planning defaults
- weekly plan adaptation logic
- future instrumentation requirements for advanced programming

## Strong Candidate Source Papers

- Resistance Training Intensity Prescription Methods Based on Lifting Velocity Monitoring
- Minimum Velocity Threshold in Response to the Free-Weight Back Squat
- Monitoring Resistance Training Intensity Using Load-Intercept from the Load-Velocity Relationship Variables
- Conceptualizing a Load and Volume Autoregulation Integrated Velocity Model
- The Effects of Percentage-Based, RPE, Repetitions in Reserve, and Velocity-Based Training on Performance and Fatigue Responses

## Candidate Promotion Targets

- future Tonal or lift-tracking instrumentation rules
- effort and fatigue interpretation logic
- next-generation session adaptation behavior
