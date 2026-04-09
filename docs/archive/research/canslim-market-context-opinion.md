# CANSLIM NO_BUY streak (last ~2 weeks): market-context opinion

## Evidence snapshot (as of 2026-02-25)

**Local system context available:**
- Prior local note (2026-02-15) recorded market regime as **UPTREND_UNDER_PRESSURE** with **6 distribution days**.

**Recent tape context (last ~10–20 sessions, proxy via index/ETF data):**
- **SPX:** ~flat 10d (-0.03%), down ~0.56% over 20d.
- **NDX / QQQ:** ~flat 10d (+0.10% / +0.59%), down ~2.9% / ~2.5% over 20d.
- **Small caps (IWM):** lagging 10d (-0.69%), roughly flat 20d.
- **Distribution pressure (last 15 sessions):**
  - SPX/NDX: ~**4** distribution-type days each (down day on higher volume proxy)
  - SPY/QQQ: ~**3** each
- **Breadth/participation proxies:**
  - **QQQ/SPY** improved short-term (10d) but still weaker vs 20d.
  - **IWM/SPY** weak short-term.
  - **RSP/SPY** improved, but not a broad momentum surge.

## CANSLIM permissiveness check

CANSLIM typically gets selective when:
1) market trend is not cleanly advancing,
2) distribution clusters rise,
3) leadership participation is narrow/choppy.

Current context matches that profile: sideways/choppy major indexes, non-trivial distribution count, mixed breadth with small-cap lag.

## Judgment

**Repeated NO_BUY over ~2 weeks looks more likely a *correct caution* than an over-restrictive failure.**

I do **not** see strong evidence that the model is obviously too tight; I see a market that is failing to provide clean CANSLIM conditions consistently.

## 3 controlled calibration experiments (paper-only, no risk increase)

1. **M-factor threshold sweep (sensitivity test)**
   - Run parallel paper signals with distribution cutoff at **4 vs 5 vs 6** and trend gate variants (price above 21DMA only vs 21+50DMA).
   - Compare: signal count, forward 5/10/20d expectancy, max adverse excursion.

2. **Breadth-confirmation gate test**
   - Keep current logic as baseline; add variant requiring at least 2 of 3 to be improving over prior 10 sessions: **RSP/SPY, IWM/SPY, QQQ/SPY**.
   - Goal: check if NO_BUY periods coincide with weak participation (good filter) or if gate is suppressing good breakouts.

3. **Staged-entry permissiveness (paper pilot only)**
   - On first BUY, simulate **starter 25% position** (paper) instead of full intended size.
   - Add only if market state improves and position confirms (+2–3% with supportive volume), otherwise auto-exit on standard risk stop.
   - Measures whether caution is missing upside or correctly avoiding failed breakouts.

---
Bottom line: keep caution bias for now, but run the three paper experiments for 3–6 weeks to quantify whether restrictions are protective or overly conservative.