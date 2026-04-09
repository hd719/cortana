# Ultimate Fitness Trainer Roadmap

Date: 2026-04-04
Status: Done

## Goal

Turn the current Cortana + OpenClaw + Spartan setup into a reliable, evidence-backed fitness coach that can:

- interpret recovery and training readiness,
- understand Tonal workouts at the session and movement level,
- manage hypertrophy versus staying lean/cutting modes,
- drive daily and weekly decisions automatically,
- and improve over time from real outcomes instead of generic advice.

Scope note:

- The immediate objective is to make the current Tonal + Whoop + nutrition baseline trustworthy and useful.
- Apple Health should be treated as a later expansion once the core coaching loop is data-clean and behaviorally credible.

## Current State Audit

### What already exists

- `cortana` already has a dedicated fitness identity:
  - `identities/spartan/IDENTITY.md`
  - `identities/spartan/MEMORY.md`
  - `identities/spartan/SOUL.md`
- Runtime config already includes a `spartan` agent and a `cron-fitness` lane in `~/.openclaw/openclaw.json`.
- Fitness cron jobs are live in `~/.openclaw/cron/jobs.json`:
  - morning brief,
  - evening recap,
  - weekly insights,
  - monthly overview,
  - freshness/risk/overreach guards.
- `cortana/tools/fitness/` already contains artifact builders for:
  - morning brief,
  - evening recap,
  - weekly insights,
  - monthly overview,
  - fitness DB persistence,
  - coach decision and nutrition logs,
  - meal parsing.
- `cortana-external` already runs a local fitness service on `http://127.0.0.1:3033`.

### What the live system is doing right now

- Tonal is healthy and authenticated via `GET /tonal/health`.
- Whoop is available locally via `GET /whoop/data`.
- The daily facts table is active:
  - `cortana_fitness_daily_facts` has rows through `2026-04-04`.
- Coaching persistence exists:
  - `coach_decision_log` has historical rows.
  - `coach_weekly_score` has weekly rows.

### Tonal surface area already available

The current local Tonal service is stronger than a simple “workout summary” integration.

It already exposes or stores:

- profile state,
- workout history,
- current and historical strength scores,
- streak information,
- total lifetime workouts and volume,
- set-level workout activity fields such as:
  - movement IDs,
  - volume,
  - duration,
  - rep metadata,
  - one-rep-max related fields,
  - power and ROM-related fields.

Current unofficial Tonal endpoints used by `cortana-external`:

- `GET /v6/users/userinfo`
- `GET /v6/users/:id/profile`
- `GET /v6/users/:id/workout-activities`
- `GET /v6/users/:id/strength-scores/current`
- `GET /v6/users/:id/strength-scores/history`

This means the Tonal side is already good enough to support:

- workout adherence,
- muscle-family progression,
- PR and plateau detection,
- movement-level load tracking,
- custom block recommendations.

### Gaps and failures in the current stack

#### 1. Data correctness is not reliable yet

This is the highest-priority problem.

The cached Whoop workout payload currently contains duplicated workout rows:

- `whoop_data.json` has `125` workout rows but only `25` unique workout IDs.
- Many workout IDs are repeated `5x`.

This is already contaminating coaching output:

- the morning artifact currently reports `whoop_workouts_today = 10`
- and `whoop_total_strain_today = 108.46`

That is almost certainly false for a normal day and appears to be the direct result of duplicated Whoop workout pagination data.

If this is not fixed first, the trainer will make bad decisions with high confidence.

#### 2. Nutrition tracking is structurally present but operationally weak

- `protein_g` is null across recent daily fact rows.
- weekly insights are currently falling back to:
  - `assume_likely_below_target_unverified`
- monthly overview shows:
  - `protein_coverage_days = 0`

The current system can speak about nutrition, but it cannot yet measure it well enough.

#### 3. Step and hydration coverage are effectively missing

Monthly artifact output currently shows:

- `step_coverage_days = 0`
- `hydration_coverage_days = 0`

That blocks higher-confidence energy expenditure, activity baseline, recovery, and leanness logic.

#### 4. The coaching layer is stronger on summaries than on programming

Today’s stack is good at:

- readiness messaging,
- summaries,
- simple risk calls,
- weekly trend text.

It is not yet strong at:

- generating Tonal-ready programming changes,
- classifying movement patterns by muscle group,
- managing fatigue by block,
- adjusting volume based on outcome history,
- handling lean bulk versus cut modes explicitly.

#### 5. Monthly analytics are still too shallow

The monthly pipeline exists, but trajectory is often `unknown` because coverage is thin and key fields are missing.

That means the system has reporting, but not yet a durable long-horizon athlete model.

## Research Synthesis

### 1. Volume matters most for hypertrophy

The strongest theme across the literature is that weekly set volume is one of the main hypertrophy levers.

- The 2025/2026 dose-response meta-regression found that more volume improved hypertrophy and strength, but with diminishing returns.
- The same paper found frequency was much less compelling for hypertrophy once volume was accounted for.

Practical implication:

- the trainer should primarily optimize weekly direct muscle-group volume,
- and use frequency as a secondary distribution tool.

### 2. During a cut, do not automatically slash resistance training volume

The lean-mass-sparing review in resistance-trained athletes suggests:

- higher RT volumes, often `>= 10 weekly sets per muscle group`, were associated with low-to-no lean mass loss in several included studies,
- and increasing volume over time during caloric restriction may outperform reducing volume.

Practical implication:

- if recovery and diet support it, the system should preserve enough hard lifting volume during fat-loss phases instead of switching too quickly into “maintenance mode.”

### 3. Real-world lifters often overshoot or misallocate volume

The 2018 paper on weekly set volume in trained lifters found that:

- many lifters were above literature-based recommendations for some muscle groups,
- and volume distribution was often imbalanced across body regions.

Practical implication:

- Spartan should not just count total work,
- it should detect undertrained and overtrained muscle families and rebalance them.

### 4. Protein targets should be mode-aware, not static

Evidence is mixed on the exact “best” protein target during energy restriction, but the directional theme is clear:

- ISSN position stand:
  - `1.4-2.0 g/kg/day` is sufficient for most exercising people for muscle gain/maintenance,
  - higher intakes can help body composition in resistance-trained people.
- 2025 ECJN trial:
  - in a 6-week `25%` energy restriction with RT, `1.2-1.7 g/kg/day` appeared sufficient to maintain FFM and performance in that sample.
- older athlete-cutting literature and the 2022 review still support a conservative bias toward higher protein when energy availability is tighter.

Practical implication:

- protein should be dynamic by mode:
  - maintenance / lean gain,
  - gentle cut,
  - aggressive cut.

### 5. Load matters less for hypertrophy than for strength

Across multiple load meta-analyses, hypertrophy appears broadly achievable across a wide spectrum of loads when sets are taken sufficiently hard, while higher loads remain more specific for maximal strength.

- volume-matched load meta-analyses found similar hypertrophy from low, moderate, and high loads,
- higher loads consistently produce better 1RM strength gains,
- very low loads can still build muscle, but they are often less time-efficient and more uncomfortable.

Practical implication:

- Spartan should not lock programming into one rep range,
- hypertrophy blocks should use a broad rep/load spectrum,
- strength-focused phases should bias heavier loading,
- Tonal recommendations should separate:
  - hypertrophy dose,
  - strength specificity.

### 6. Training to failure is optional, not mandatory

The current literature does not support the idea that every working set must be taken to failure to maximize growth.

- meta-analyses on proximity to failure suggest no clear hypertrophy advantage for taking all sets to momentary muscular failure,
- failure may still be useful selectively, especially on safer isolation or machine-based work,
- the cost of excessive failure is fatigue, recovery burden, and lower sustainable volume quality.

Practical implication:

- Spartan should model effort as a variable,
- the default should be “close enough” rather than “all the way” on every set,
- a good operating baseline is to keep most work roughly in the `0-3 RIR` range and reserve true failure for selected contexts.

### 7. Frequency is mainly a distribution tool

Frequency helps mostly because it distributes weekly work more effectively.

- older frequency meta-analyses suggest training a muscle group at least twice weekly is often superior to once weekly,
- newer work suggests frequency has less independent value once weekly volume is already accounted for,
- higher frequency is especially useful when weekly set volume is high and session quality would otherwise collapse.

Practical implication:

- Spartan should use frequency to preserve performance and technique quality,
- not treat frequency as a magic hypertrophy variable independent of weekly volume.

### 8. Rest intervals should protect output, not chase fatigue for its own sake

The literature on rest periods does not show a strong hypertrophy penalty for longer rests, and there is some trend in favor of longer rests when set quality matters.

- systematic reviews and a 2024 Bayesian meta-analysis show broadly similar hypertrophy across rest conditions,
- shorter rests can become a hidden volume-quality limiter when loads are heavy or session density is already high.

Practical implication:

- Spartan should bias longer rests for compounds, high-output sets, and high-volume phases,
- and use shorter rests mainly where time efficiency matters and the exercise is less systemically costly.

### 9. Cardio can coexist with hypertrophy, but interference has to be managed

The research does not support the simplistic idea that “cardio kills gains,” but mode and context matter.

- concurrent training meta-analysis suggests some interference risk for hypertrophy,
- this appears more pronounced with running than cycling in some analyses,
- resistance training remains essential during fat-loss phases for preserving lean mass.

Practical implication:

- Spartan should distinguish:
  - Zone 2 cycling or incline walking,
  - HIIT,
  - running,
  - lower-body-impacting conditioning,
- and should not treat all cardio as equivalent.

Default logic should be:

- prefer lower-interference modalities when lower-body hypertrophy is a priority,
- keep cardio dose explicit,
- and reduce junk conditioning before cutting productive lifting volume.

### 10. Cutting should be slow enough to preserve muscle

The contest-prep and athlete-cutting literature is directionally consistent:

- bodyweight loss rates around `0.5-1.0% per week` are a good muscle-retention starting range,
- more aggressive rates raise the probability of performance decline, fatigue, and lean mass loss,
- higher protein intakes and maintained RT quality become more important as leanness increases and energy availability drops.

Practical implication:

- Spartan should actively manage the rate of loss instead of only tracking body weight,
- and should flag cuts that are too aggressive relative to recovery and training performance.

### 11. Protein strategy should prioritize total intake first, distribution second

The protein literature is consistent enough to support a concrete baseline.

- for most muscle gain and maintenance phases, around `1.6-2.2 g/kg/day` is a strong default operating range,
- during leaner, harder, or more aggressive dieting phases, the bodybuilding and athlete-cutting literature supports using a more conservative muscle-sparing range, often expressed as `2.3-3.1 g/kg lean body mass/day`,
- protein distribution still matters, but much less than hitting the daily total.

Practical implication:

- Spartan should support both:
  - bodyweight-based targets,
  - lean-body-mass-based targets,
- and select the target logic by phase.

Useful operational defaults:

- hypertrophy / maintenance:
  - `1.6-2.2 g/kg/day`
- gentle cut:
  - `1.8-2.4 g/kg/day`
- aggressive cut / very lean phase:
  - use a conservative upper muscle-sparing model such as `2.3-3.1 g/kg LBM/day`

### 12. Meal timing is secondary, but meal structure still matters

Daily total protein is the primary driver, but structured feeding still helps.

- ISSN and contest-prep recommendations support evenly distributed protein feedings,
- practical meal structures of `3-6` feedings per day remain defensible,
- a useful per-meal target is roughly `0.25-0.40 g/kg` or about `20-40 g` high-quality protein depending on body size and age.

Practical implication:

- Spartan should coach meal structure simply:
  - protein total first,
  - then feed count,
  - then peri-workout optimization.

### 13. Pre-sleep protein is a useful lever, not a requirement

Pre-sleep protein has enough support to be worth including as an optional tool.

- pre-sleep protein studies and reviews suggest `20-40 g` before bed can improve the overnight protein synthetic response,
- some training studies suggest benefits for strength and hypertrophy over time,
- this is most useful when training happens later in the day or daily protein would otherwise come in low.

Practical implication:

- Spartan should treat pre-sleep protein as:
  - optional,
  - high-leverage when evening training occurred,
  - especially useful on cuts or low-intake days.

### 14. Sleep is not a wellness nice-to-have; it is a muscle-retention variable

Sleep restriction and sleep deprivation have direct anabolic consequences.

- acute sleep deprivation research shows reduced muscle protein synthesis and a more catabolic hormonal environment,
- sleep restriction studies show reduced myofibrillar protein synthesis,
- poor sleep quality should therefore influence volume tolerance, recovery calls, and cut aggressiveness.

Practical implication:

- Spartan should treat sleep as a hard control input,
- not as flavor text around recovery.

## Expanded Scientific Baseline

The roadmap above is now grounded in a set of operating assumptions that Spartan should encode directly.

These are starting defaults, not dogma.
They should be individualized once sufficient personal response history exists.

### Training defaults Spartan should start with

- Weekly direct-set volume is the primary hypertrophy dial.
- A practical starting operating band is roughly `10-20` direct hard sets per muscle per week, then individualized up or down from response.
- Frequency should usually be `>=2x/week` per muscle when practical, mainly to distribute volume and preserve quality.
- Hypertrophy can be built across a wide load range, so rep ranges should stay flexible.
- Strength-focused work should keep a heavier-load bias.
- Most working sets do not need true failure.
- A practical effort baseline is `0-3 RIR` for most work, with true failure used selectively.
- Rest intervals should be long enough to preserve set quality, especially on compounds and high-output work.

### Leanness defaults Spartan should start with

- Default cut rate target:
  - `0.5-1.0%` bodyweight loss per week.
- Do not solve cuts by immediately slashing productive lifting volume.
- Keep resistance training quality high during a cut.
- Use cardio as a controllable energy-expenditure tool, not as punishment volume.
- Prefer lower-interference cardio modes when hypertrophy is the priority.

### Nutrition defaults Spartan should start with

- Daily protein total is the first nutrition KPI.
- Meal logging must be good enough to distinguish:
  - total protein,
  - caloric adherence,
  - hydration,
  - training-day versus rest-day structure.
- Per-meal protein targets should be tracked, but only after daily totals are reliable.
- Carbohydrate availability should be treated as training-supportive fuel, not just calories to eliminate.
- Fat intake should have a floor, not be allowed to drift arbitrarily low.

### Recovery defaults Spartan should start with

- Sleep debt should directly reduce confidence in aggressive overload decisions.
- Low sleep plus low readiness should trigger volume reduction before intensity inflation.
- Pre-sleep protein is a tactical recovery option, not a universal rule.
- Optional diet breaks or maintenance weeks may be useful in longer cuts when performance, fatigue, or adherence deteriorate.

## Research-Backed System Requirements

If Spartan is going to behave like a real coach, it needs to represent the variables the literature actually says matter.

### Variables Spartan must explicitly model

- direct hard sets per muscle group per week
- session frequency per muscle group
- load bucket:
  - very low,
  - low,
  - moderate,
  - high
- rep bucket
- effort / proximity-to-failure estimate
- rest interval bucket
- cardio mode:
  - walking,
  - cycling,
  - running,
  - HIIT
- cardio dose
- body-weight trend
- target rate of loss or gain
- protein total
- protein distribution
- carbohydrate support around training
- sleep debt
- readiness confidence
- cut severity

### Decisions Spartan should eventually own

- whether weekly volume should rise, hold, or fall
- whether a muscle group is underdosed, appropriately dosed, or overdosed
- whether the current cut rate is too aggressive
- whether cardio is helping or interfering
- whether poor sleep should override the planned session
- whether protein is sufficient for the current phase
- whether a deload, diet break, or maintenance week is warranted

## Tonal Product Reality

Official Tonal product pages show the app already supports:

- custom workouts,
- progress tracking,
- detailed workout metrics,
- planning a weekly routine,
- Daily Lift,
- dynamic weight modes,
- personalized weight recommendations.

Important interpretation:

- Tonal already solves part of the workout execution UX.
- Your opportunity is not to replace Tonal.
- Your opportunity is to build the decision brain above Tonal:
  - readiness,
  - program adaptation,
  - nutrition coupling,
  - recovery gating,
  - longitudinal strategy.

No official public developer API docs were found during this pass.
The current local integration should be treated as an unofficial/private API dependency that needs defensive engineering.

## Roadmap

### Phase 0: Fix trust and measurement

Owner: `cortana-external` first, then `cortana`

Deliverables:

- fix Whoop workout pagination duplication in `apps/external-service/src/whoop/service.ts`
- add dedupe by workout ID before cache persistence
- add tests proving no repeated workouts across paginated pulls
- correct daily strain/workout counts in morning and evening fitness artifacts
- persist step data if it exists in the provider payload
- add explicit artifact quality flags:
  - duplicated_workouts_detected
  - missing_step_signal
  - missing_protein_signal
  - stale_tonal
  - stale_whoop

Exit criteria:

- daily strain matches raw provider reality,
- same-day workout counts are believable,
- step coverage is either present or explicitly marked unavailable,
- coaching does not silently reason over bad data.

### Phase 1: Build the canonical athlete state model

Owner: `cortana`

Deliverables:

- create one canonical daily athlete state artifact combining:
  - readiness,
  - sleep,
  - strain,
  - Tonal load,
  - muscle-family volume,
  - load buckets,
  - rep buckets,
  - estimated effort / RIR,
  - inter-set rest buckets when inferable,
  - cardio mode and dose,
  - nutrition adherence,
  - body-weight trend if available,
  - cut / maintenance / gain mode
- add muscle-family mapping for Tonal movement IDs
- compute weekly direct-set estimates by muscle family:
  - chest,
  - back,
  - quads,
  - hamstrings,
  - glutes,
  - shoulders,
  - biceps,
  - triceps,
  - calves,
  - core
- track:
  - fatigue debt,
  - progression momentum,
  - underdosed muscles,
  - overdosed muscles,
  - interference risk from cardio,
  - confidence score for every training recommendation

Exit criteria:

- Spartan can answer:
  - what was trained,
  - how much,
  - whether it was enough,
  - and what should happen next.

### Phase 2: Make nutrition real instead of inferred

Owner: `cortana`

Deliverables:

- upgrade meal parsing into a first-class nutrition pipeline
- require daily logging of:
  - protein,
  - calories,
  - hydration,
  - optional carbs/fats
- create mode-specific protein targets:
  - maintenance / lean gain,
  - cut,
  - aggressive cut
- add explicit target-loss logic:
  - default cut target `0.5-1.0%` bodyweight per week,
  - flag aggressive loss rates that threaten lean-mass retention
- add weekly energy-balance logic:
  - target rate of loss,
  - calorie adjustments,
  - protein floor,
  - fat floor,
  - training-supportive carbohydrate floor,
  - adherence scoring
- detect under-fueling risk:
  - high load + low intake,
  - multi-day deficits,
  - low protein during a cut
- add meal-structure logic:
  - `3-6` feedings/day when feasible,
  - per-meal protein targets,
  - optional pre-sleep protein recommendations on evening-training or low-protein days

Exit criteria:

- weekly insight artifacts stop saying “assume unverified” for protein,
- nutrition becomes a measured input to coaching, not a guess.

### Phase 3: Build the actual training intelligence layer

Owner: `spartan` + `cortana`

Deliverables:

- daily readiness decision engine:
  - push,
  - controlled train,
  - technique / Zone 2,
  - recover
- volume allocator by muscle family and goal mode
- evidence-based set prescription rules:
  - direct weekly set targets,
  - frequency targets,
  - load distribution targets,
  - effort targets
- overload engine:
  - add sets,
  - hold,
  - deload,
  - substitute movement,
  - swap to recovery emphasis
- plateau detector using:
  - Tonal strength score trends,
  - movement-level volume,
  - recent recovery,
  - sleep trend
- cut-aware training rules:
  - maintain intensity,
  - avoid panic volume cuts,
  - reduce junk fatigue first,
  - keep hypertrophy stimulus adequate,
  - use cardio changes before sacrificing productive resistance work
- cardio interference rules:
  - distinguish walking / cycling / running / HIIT,
  - identify lower-body hypertrophy conflicts,
  - recommend lower-interference conditioning when needed
- sleep override rules:
  - poor sleep lowers overload confidence,
  - repeated sleep restriction triggers more conservative programming

Exit criteria:

- Spartan can generate a credible next-week plan,
- not just summarize the past week.

### Phase 4: Tonal-native programming and workout generation

Owner: `spartan`

Deliverables:

- classify the current Tonal program and custom workout library
- build templates for:
  - hypertrophy push/pull/legs,
  - upper/lower,
  - lean-maintenance cut blocks,
  - short recovery sessions,
  - travel / no-Tonal substitutions
- recommend or generate custom workout blocks that align with:
  - target weekly sets,
  - lagging muscle groups,
  - recovery status,
  - available session time
- support “what should I do on Tonal tomorrow?” as a deterministic answer

Exit criteria:

- the system can convert strategy into actual Tonal-executable sessions.

### Phase 5: Coaching UX and operating loop

Owner: `spartan` + `monitor`

Deliverables:

- tighten morning/evening/weekly cadence into one coherent loop
- add “today’s mission” format:
  - readiness,
  - top risk,
  - muscle-group target,
  - protein target,
  - sleep target
- add alerting for:
  - accumulated fatigue,
  - missed protein minimums,
  - undertrained lagging muscle groups,
  - rising strain with falling recovery,
  - cut going too fast
- add post-workout ingestion:
  - natural-language workout notes,
  - soreness,
  - motivation,
  - pain flags,
  - schedule constraints

Exit criteria:

- coaching feels like a closed-loop system, not isolated cron messages.

## Recommended Build Order

### Next 7 days

- Fix Whoop duplication and artifact correctness.
- Add movement-to-muscle-family mapping for Tonal.
- Persist clean same-day training load.
- Make weekly outputs explicitly show direct weekly sets by muscle family.
- Add effort, load, and cardio metadata to the canonical athlete state.

### Next 30 days

- Build the canonical athlete state artifact.
- Upgrade protein logging and adherence scoring.
- Add cut / maintenance / gain mode.
- Add explicit weekly rate-of-loss targeting.
- Encode evidence-based defaults for volume, frequency, load, and effort.
- Generate next-week recommendations from real data.

### Next 60-90 days

- Add Tonal-native custom workout recommendations.
- Add adaptive progression logic.
- Add a confidence score for every coaching decision.
- Add cardio interference management.
- Add sleep-based auto-regulation and optional diet-break logic.
- Add evaluation against outcomes:
  - better readiness?,
  - stronger lifts?,
  - better body composition adherence?,
  - fewer overreach days?

## What “Ultimate” Should Mean Here

The end-state should not be “an AI that says motivational fitness things.”

It should be:

- a reliable athlete-state model,
- a data-clean recovery and workload pipeline,
- a Tonal-aware programming engine,
- a nutrition-aware body-composition controller,
- and a coach that changes behavior based on actual response history.

That is the path from today’s good scaffolding to an actual high-quality fitness trainer.

## Source Notes

Local papers reviewed:

- `~/Desktop/training/s40279-025-02344-w.pdf`
- `~/Desktop/training/s00421-022-04896-5.pdf`
- `~/Desktop/training/mHgY83THKzb4rx46c7p3FGD.pdf`

Web references used:

- ISSN protein position stand:
  - https://link.springer.com/article/10.1186/s12970-017-0177-8
- Natural bodybuilding contest-prep nutrition review:
  - https://link.springer.com/article/10.1186/1550-2783-11-20
- Natural bodybuilding contest-prep resistance/cardio review:
  - https://pubmed.ncbi.nlm.nih.gov/24998610/
- Protein supplementation meta-analysis:
  - https://pubmed.ncbi.nlm.nih.gov/28698222/
- High versus lower protein during energy deficit trial:
  - https://pubmed.ncbi.nlm.nih.gov/26817506/
- Proximity-to-failure hypertrophy meta-analysis:
  - https://pubmed.ncbi.nlm.nih.gov/36334240/
- Failure versus non-failure meta-analysis:
  - https://pubmed.ncbi.nlm.nih.gov/33497853/
- Resistance training load meta-analysis:
  - https://pubmed.ncbi.nlm.nih.gov/33874848/
- Volume-matched load meta-analysis:
  - https://pubmed.ncbi.nlm.nih.gov/35015560/
- Frequency and hypertrophy meta-analysis:
  - https://pubmed.ncbi.nlm.nih.gov/27102172/
- Rest interval Bayesian meta-analysis:
  - https://pubmed.ncbi.nlm.nih.gov/39205815/
- Concurrent training hypertrophy meta-analysis:
  - https://pubmed.ncbi.nlm.nih.gov/35476184/
- Sleep deprivation and muscle protein synthesis:
  - https://pubmed.ncbi.nlm.nih.gov/33400856/
- Sleep restriction and myofibrillar protein synthesis:
  - https://pubmed.ncbi.nlm.nih.gov/32078168/
- Pre-sleep protein systematic review:
  - https://pubmed.ncbi.nlm.nih.gov/32811763/
- Diet break athlete study:
  - https://pubmed.ncbi.nlm.nih.gov/33630880/
- 2025 high-protein energy-restriction trial:
  - https://www.nature.com/articles/s41430-025-01585-2
- Tonal mobile app:
  - https://tonal.com/mobile
- Tonal custom workouts:
  - https://tonal.com/blog/build-your-own-custom-workouts
- Tonal routine planning:
  - https://tonal.com/blogs/all/routine-planning/
- Tonal Daily Lift:
  - https://tonal.com/blogs/all/your-daily-lift-a-smart-workout-built-just-for-you
