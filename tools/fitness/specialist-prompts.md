# 🏋️ Fitness Specialist Agent — Spawnable Templates

Use these to spawn deep fitness analysis on demand. Just tell Cortana what you want and she'll spawn the right specialist.

---

## Available Analyses

### 1. Sleep-Recovery Correlation
**Trigger:** "Analyze my sleep vs recovery patterns"
```
Analyze Hamel's sleep-recovery correlation over the last 30 days.

Fetch: curl -s http://localhost:3033/whoop/data

Analyze:
- Which sleep metrics most strongly predict green recovery?
- Optimal sleep duration for green recovery
- Impact of sleep consistency vs total hours
- Deep sleep / REM thresholds for good recovery
- Time to bed patterns and next-day recovery

Create: ~/openclaw/memory/fitness/analysis/sleep-recovery-correlation.md
```

### 2. Strength Progression (Tonal Program)
**Trigger:** "How has my strength progressed?"
```
Analyze Hamel's strength progression through his Tonal program.

Fetch: curl -s http://localhost:3033/tonal/data

Analyze:
- Volume trends week over week
- 1RM estimates progression for key movements
- Sets/reps progression
- Which muscle groups showing most gains
- Compare early weeks to recent weeks

Create: ~/openclaw/memory/fitness/analysis/strength-progression.md
```

### 3. Optimal Strain Analysis
**Trigger:** "What's my optimal strain for green recovery?"
```
Analyze the relationship between daily strain and next-day recovery.

Fetch: curl -s http://localhost:3033/whoop/data

Analyze:
- Strain levels that lead to green vs yellow vs red recovery
- Your personal strain ceiling before recovery tanks
- Cumulative strain patterns (back-to-back high strain days)
- Recovery time after different strain levels

Create: ~/openclaw/memory/fitness/analysis/optimal-strain.md
```

### 4. Weekly Performance Report
**Trigger:** "Give me a deep weekly fitness report"
```
Comprehensive weekly fitness analysis.

Fetch both:
- curl -s http://localhost:3033/whoop/data
- curl -s http://localhost:3033/tonal/data

Report:
- Days trained, volume lifted, cardio minutes
- Average strain, recovery, sleep scores
- Trend vs previous week
- Muscle group coverage
- Standout performances and areas for improvement
- Recommendations for next week

Create: ~/openclaw/memory/fitness/weekly/YYYY-WXX-deep-analysis.md
```

### 5. Program Completion Forecast
**Trigger:** "Am I on track to finish my program?"
```
Analyze progress through 12 Weeks to Jacked program.

Fetch: curl -s http://localhost:3033/tonal/data

Analyze:
- Current week/day in program
- Workouts completed vs expected
- Projected completion date
- Any skipped workouts or gaps
- Recommendations to stay on track

Create: ~/openclaw/memory/fitness/analysis/program-forecast.md
```

### 6. HRV Trend Analysis
**Trigger:** "Analyze my HRV trends"
```
Deep dive into HRV patterns.

Fetch: curl -s http://localhost:3033/whoop/data

Analyze:
- 7-day, 14-day, 30-day HRV averages
- Day-of-week patterns
- Correlation with sleep, strain, alcohol
- Your personal HRV baseline and ranges
- Warning signs to watch for

Create: ~/openclaw/memory/fitness/analysis/hrv-trends.md
```

---

## How to Request

Just say something like:
- "Spawn fitness specialist: analyze my sleep vs recovery"
- "I want a deep dive on my strength progression"
- "Run the weekly performance report"

Cortana will spawn the appropriate agent and deliver results.

---

## Output Location

All analyses saved to: `~/openclaw/memory/fitness/analysis/`
