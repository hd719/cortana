# CANSLIM NO_BUY Investigation (2026-02-25)

## Executive conclusion

**Primary cause is market+score regime behavior, not a core scoring bug.**

Persistent `NO_BUY` over the recent run window is mostly explained by:
1. **Market regime stayed `uptrend_under_pressure`** with elevated distribution days (6 → 5 → 4), which enforces defensive sizing.
2. **Top candidates repeatedly scored `6/12`, below hard buy gate `>=7`**.

There were also **runner reliability issues** (wrong python binary in some runs, disallowed model in one run), but these produced explicit error outputs and do **not** explain the repeated `NO_BUY` decisions on successful scans.

---

## Scope completed

- Located alert runner and scoring logic in `cortana-external/backtester`.
- Pulled and analyzed CANSLIM cron run history from `~/.openclaw/cron/runs/9d2f7f92-b9e9-48bc-87b0-a5859bb83927.jsonl`.
- Extracted per-day regime/distribution/candidate/outcome from available logs.
- Verified data freshness and cache behavior.
- Validated score math + gates in source.
- Determined root causes and proposed safe experiments.
- Wrote this report.
- Updated task board with completed investigation task.

---

## 1) Code locations (runner + logic)

### Alert runner
- `backtester/canslim_alert.py`
  - Entry: `format_alert(limit=8, min_score=6)`
  - Uses `TradingAdvisor` methods:
    - `get_market_status(refresh=True)`
    - `scan_for_opportunities(quick=True, min_score=6)`
    - `analyze_stock(symbol)` for each candidate

### Recommendation engine / gates
- `backtester/advisor.py`
  - Hard buy gate in `_generate_recommendation(...)`:
    - `if total_score < 7: action='NO_BUY'`
  - Market hard block:
    - `if market.regime == CORRECTION: action='NO_BUY'`
  - Near-high gate:
    - `if pct_from_high < 85: action='WATCH'`

### Market regime (M factor)
- `backtester/data/market_regime.py`
  - Distribution day count over last 25 sessions
  - Regime thresholds:
    - `>=5` dist days + downtrend => `correction` (0% sizing)
    - `>=5` + non-downtrend => `uptrend_under_pressure` (50% sizing)
    - `>=3` => `uptrend_under_pressure` (75% sizing)

### Candidate screening + scoring inputs
- `backtester/data/universe.py`
  - Initial technical screen based on N/L/S technical (`technical_score`)
- `backtester/data/fundamentals.py`
  - Fundamental scoring C/A/I/S (float-based S)

---

## 2) Last-14-day run extraction (available history)

Cron is weekday `09:30,12:30,15:30 ET`, but available run records in this environment begin on **2026-02-16**.

Daily summary below uses available runs for each date in the last 14 calendar days.

| Date (ET) | Run health | Market regime | Distribution days | Candidate list | Score breakdown | Buy threshold | Final action |
|---|---|---|---:|---|---|---|---|
| 2026-02-12 | No run data in file | n/a | n/a | n/a | n/a | >=7 | n/a |
| 2026-02-13 | No run data in file | n/a | n/a | n/a | n/a | >=7 | n/a |
| 2026-02-14 | Weekend | n/a | n/a | n/a | n/a | >=7 | n/a |
| 2026-02-15 | Weekend | n/a | n/a | n/a | n/a | n/a | n/a |
| 2026-02-16 | 2 successful runs | uptrend_under_pressure | 6 | VRTX, REGN (from summary text) | not logged per factor in summary | >=7 | NO_BUY |
| 2026-02-17 | 3 runs (1 path/python issue, 2 success) | uptrend_under_pressure | 6 | AMAT, LRCX, ON, MPWR, REGN, TRGP, HWM, VRT | not logged per factor in summary | >=7 | NO_BUY |
| 2026-02-18 | 3 successful runs | uptrend_under_pressure | 6 | AMAT, LRCX, ON, MPWR, REGN, TRGP, HWM, VRT (varied run-to-run) | not logged per factor in summary | >=7 | NO_BUY |
| 2026-02-19 | 3 successful runs | uptrend_under_pressure | 6 | AMAT, REGN, MRNA, TRGP, GE, HWM, VRT (varied by run) | not logged per factor in summary | >=7 | NO_BUY |
| 2026-02-20 | 3 successful runs | uptrend_under_pressure | 5 | AMAT, LRCX, ON, MPWR, REGN, MRNA, TRGP, GE, HWM, VRT (varied by run) | not logged per factor in summary | >=7 | NO_BUY |
| 2026-02-21 | No run (not scheduled) | n/a | n/a | n/a | n/a | >=7 | n/a |
| 2026-02-22 | Weekend | n/a | n/a | n/a | n/a | >=7 | n/a |
| 2026-02-23 | 3 runs (1 unavailable-system msg, 1 success, 1 python cmd error) | uptrend_under_pressure | 5 | CFLT, AMAT, LRCX, ON, MPWR, REGN, MRNA, TRGP, GE, HWM, VRT | not logged per factor in summary | >=7 | NO_BUY / errors |
| 2026-02-24 | 3 runs (09:30 python error; 12:30+15:30 success) | uptrend_under_pressure | 5 | CFLT, MPWR, GE, HWM | **All 6/12** (explicit) | >=7 | NO_BUY |
| 2026-02-25 | 2 runs (09:30 model-not-allowed error; 12:30 success) | uptrend_under_pressure | 4 | CFLT, MPWR, GE, HWM | **All 6/12** (explicit) | >=7 | NO_BUY |

### Explicit per-candidate scores observed in successful recent alerts
(From 2026-02-24/25 scan output)
- CFLT: 6/12 → NO_BUY
- MPWR: 6/12 → NO_BUY
- GE: 6/12 → NO_BUY
- HWM: 6/12 → NO_BUY

---

## 3) Deeper score breakdown (current reproducible check)

Re-ran `TradingAdvisor.analyze_stock()` on recurring symbols:

- **CFLT**: total 6 = C2 + A0 + I0 + S(fund)0 + N2 + L2
- **MPWR**: total 6 = C1 + A0 + I0 + S(fund)1 + N2 + L2
- **GE**: total 6 = C2 + A0 + I0 + S(fund)0 + N2 + L2
- **HWM**: total 6 = C2 + A0 + I0 + S(fund)0 + N2 + L2

Pattern: candidates are technically strong (N/L mostly maxed), but fundamentals rarely add enough points to cross 7.

---

## 4) Data freshness / input quality validation

### What is healthy
- Live market data is current (e.g., SPY and candidate bars updated for 2026-02-25).
- Cache refresh behavior works for active symbols (many cache files updated within ~0.4h during tests).

### Issues found
1. **Intermittent cron execution reliability issues**:
   - `zsh: command not found: python` on some runs.
   - `model not allowed: openai-codex/gpt-5.1-codex-max` on one run.
2. **Noisy dependency warning**:
   - yfinance/pandas `Timestamp.utcnow` deprecation warnings appear in output (noise, not decision logic failure).

### Timezone/session-boundary
- Cron schedule is ET (`30 9,12,15 * * 1-5`).
- No direct evidence of timezone boundary bug affecting decisions.

---

## 5) Scoring math and gate validation

### Confirmed gates
- Buy requires **all**:
  1. market not `correction`
  2. `total_score >= 7`
  3. `pct_from_high >= 85`
- In observed runs, failures are overwhelmingly on gate #2 (`score too low`).

### Important implementation detail
- Final `total_score` uses: `C + A + I + S(fund) + N + L`.
- `S_score` from technical volume analysis is used for screening but **not included** in final `total_score`.
  - This is not a runtime bug per se, but it is a design choice that materially reduces score headroom.

---

## 6) Root-cause assessment

### Is this correct market-regime behavior or a bug?

**Mostly correct behavior under current rules**, with operational noise:
- Regime has been under pressure (4–6 distribution days), so caution is expected.
- Candidate scores repeatedly cluster at 6, below hard buy threshold 7.
- Therefore repeated `NO_BUY` is logically consistent with implemented rules.

**Not a data corruption issue** observed.

**Secondary issue:** cron reliability glitches caused a few failed/error runs and can distort perception of system health.

---

## 7) Safe improvements / experiments (no prod default changes made)

### A) Reliability hardening (recommended first)
1. Keep cron payload fixed to explicit venv interpreter only:
   - `/Users/hd/Developer/cortana-external/backtester/venv/bin/python canslim_alert.py ...`
2. Remove disallowed model references from cron job config/session templates.
3. Add lightweight run telemetry row (JSON) per scan for deterministic auditing.

### B) Parameter experiments (paper-trade / shadow mode)
1. **Threshold sensitivity test**:
   - Compare `BUY >=7` vs `BUY >=6` in shadow over 2–4 weeks.
2. **Score component experiment**:
   - Add technical `S_score` into final score (or rebalance fundamental S weighting) in shadow branch.
3. **Regime-aware threshold**:
   - e.g., `>=7` in confirmed uptrend, `>=8` under pressure (or inverse only with strict risk controls).

### C) Explainability upgrade
- Persist per-candidate factor breakdown each run (`C/A/I/Sf/N/L/(St)`) so future investigations are exact, not inferred.

---

## 8) Changes made

- **No production code changes** made in this investigation.
- Added task board completion entry in `cortana_tasks`:
  - `Investigate persistent CANSLIM NO_BUY outputs` marked `done` with outcome summary.

---

## Final verdict

`NO_BUY` persistence is **primarily expected behavior** from current CANSLIM implementation (under-pressure market + repeated 6/12 scores below hard 7/12 buy gate), **not a hard bug in core decision logic**.

The actionable problem to fix is **run reliability and observability**, then run controlled threshold/weight experiments in shadow mode to see if strictness is too high for current market structure.
