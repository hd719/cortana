# Polymarket-Driven Improvements to the Trading Strategy

**Status:** Draft for implementation planning  
**Owner:** Cortana  
**Context:** We now have a production-wired Polymarket context layer feeding the existing Python backtester alert path.

This PRD now covers **both US equities and crypto trading strategy improvements** so the alerting and idea-generation layer can support stocks and crypto together instead of treating crypto as an afterthought.

---

## Core Principle

**Do not let Polymarket become the strategy.**

Best use:
- improve timing context
- improve watchlist quality
- improve conviction calibration
- improve risk framing
- improve alert usefulness

Wrong use:
- direct trade triggers from event odds
- overriding regime/technical controls
- treating prediction markets as truth instead of crowd pricing

The stack should remain:
1. **Python regime + technical engine = primary decision-maker**
2. **Polymarket = context / overlay / watchlist enrichment**
3. **Risk controls = final authority**

Across both asset classes:
- **Equities:** use Polymarket to improve macro context, sector rotation, early-runway stock discovery, and exit awareness
- **Crypto:** use Polymarket to improve regime context, narrative detection, policy/regulatory interpretation, and early identification of coins or proxies gaining real momentum

---

## Highest-Leverage Improvements

## Strategic Objective

We are not trying to build a magical `know everything` machine. We are trying to build a disciplined edge that helps answer three questions earlier than the crowd:

1. **Where is the market likely going?**
2. **Which assets are gaining real runway early enough to buy before they get popular?**
3. **When is a move maturing enough that we should manage or sell strength instead of chasing or bag-holding?**

The real win is not more information. The real win is **earlier, better-filtered information** that can be turned into:
- better watchlists
- earlier entries
- fewer late chases
- better exit awareness
- clearer operator conviction

This means the system should not just comment on assets already in the portfolio. It should help discover stocks, crypto assets, and related proxies that are starting to matter before they become consensus trades.

### Explicit cross-asset goal
The strategy layer should support:
- **stocks**
- **spot crypto**
- **crypto-linked equities and proxies** when useful (for example COIN, HOOD, MSTR, MARA, miners, ETFs, or ETH ecosystem proxies)

### Crypto emphasis
Ethereum should be treated as a first-class tracked asset, not a side note. The system should be able to improve ETH-related alerts, macro context, and thesis timing using both traditional market signals and Polymarket trend data.

---

## 1. Add a Polymarket conviction modifier to existing setups

### What to do
For already-valid stock setups, add a small overlay state:
- `supportive`
- `neutral`
- `conflicting`

### How it helps
This gives better trade selection without corrupting the core engine.

### Example
- NVDA setup is technically valid
- Polymarket easing odds rising, recession odds stable -> `supportive`
- Same setup during rising recession risk / inflation risk -> `conflicting`

### Use in practice
- supportive: slightly more willing to prioritize the setup
- neutral: no change
- conflicting: require stronger confirmation before taking it

### Rule
**Never let this create a trade by itself.**

---

## 2. Build a macro-sensitive watchlist tier

### Cross-asset expansion
This should become a **cross-asset watchlist system** with separate but connected buckets:
- technical stock watchlist
- Polymarket-sensitive stock watchlist
- crypto watchlist
- Polymarket-sensitive crypto watchlist
- overlap names / overlap assets


### Important upgrade
This watchlist should not be limited to current holdings.

It should include:
- names already owned
- names already on the technical watchlist
- **new names gaining credible macro/narrative runway even if we do not own them yet**

That is how this becomes an idea-generation edge instead of a portfolio commentary toy.


### What to do
Split watchlists into:
- technical watchlist
- Polymarket macro-sensitive watchlist
- overlap names

### Why it matters
Right now the best use of Polymarket is often not BUY/SELL — it is identifying **which names deserve attention before charts fully move**.

### Example mappings
- easing odds rising -> QQQ, IWM, NVDA, AMD, MSFT
- recession odds rising -> XLU, XLV, COST, defensive quality
- geopolitical escalation -> XOM, CVX, LMT, NOC; caution airlines/high beta
- crypto policy support -> COIN, HOOD, MARA, MSTR, BTC, ETH, SOL
- ETH ecosystem strength / ETH-friendly policy or adoption themes -> ETH, ETH beta names, Coinbase-related flow, L2 / ecosystem proxies where supported
- risk-on crypto momentum with supportive macro -> BTC, ETH, SOL plus crypto-linked equities

### Improvement
Surface the **overlap bucket first**:
- names that are both technically interesting and Polymarket-relevant

Also add an **early-runway bucket**:
- names not yet owned
- names not yet crowded
- names where Polymarket theme support and stock action are starting to align

That bucket is where the real asymmetry may live.

---

## 3. Add a divergence monitor between tape and prediction markets

### What to do
Track when Polymarket and the market regime disagree for multiple runs.

### Why it matters
Those are often the most informative moments.

### Example divergence states
- Polymarket risk-on, equities still in correction
- Polymarket recession risk rising, market still levitating
- geopolitical escalation odds rising while cyclicals ignore it

### Use
These should create:
- caution flags
- “wait for confirmation” notes
- higher-value operator commentary

### Not a direct trade rule
Divergence is a **warning / preparation signal**, not an auto-short or auto-long.

---

## 4. Add change-based trigger thresholds, not just static probability snapshots

### What to do
Focus more on **odds movement** than raw probability level.

### Best candidates
- 1h change
- 4h change
- 24h change
- threshold crossings

### Examples
- Fed easing odds +8 pts / 24h
- recession odds +6 pts / 24h
- geopolitical escalation +5 pts / 4h

### Why it matters
Static levels are often less informative than **rate of change**.

### Recommendation
Create a simple event severity classification:
- minor
- notable
- major

Only notable/major should meaningfully affect summaries.

---

## 5. Use Polymarket to prioritize sector rotation checks

### Crypto version of the same idea
Use Polymarket to prioritize **crypto regime checks** and search order too.

### Example
If crypto-policy odds improve or ETF / adoption narratives strengthen:
- inspect BTC
- inspect ETH
- inspect SOL and high-beta majors as appropriate
- inspect COIN / HOOD / MSTR / miners for correlated setups

If recession or liquidity stress odds rise:
- inspect whether crypto is acting as high-beta risk-on or showing relative resilience
- inspect ETH/BTC relative strength
- inspect whether crypto-linked equities are overreacting versus spot

### Why it matters
This turns Polymarket into a better search-order input for crypto the same way it does for sectors in stocks.


### What to do
When macro odds shift, tell the stock stack which sectors deserve extra scrutiny.

### Example
If easing odds rise:
- inspect semis
- inspect software
- inspect small caps
- inspect speculative growth

If recession odds rise:
- inspect defensives
- inspect staples
- inspect utilities
- inspect weak cyclicals for breakdown risk

### Why it matters
This turns macro context into a better **search order** for the existing strategy.

### Better framing
Not: “buy semis because Polymarket says so”  
But: “check semis first because macro odds just shifted in a way that could matter.”

---

## 6. Create a Polymarket-informed aggression dial

### Cross-asset requirement
The aggression dial should be able to express different posture for:
- stocks
- crypto majors
- crypto high-beta / speculative names

Example:
- supportive macro + supportive crypto-policy or adoption odds = more willingness to stalk ETH or crypto-linked setups
- fragile equity regime but strong crypto-specific narrative = allow selective crypto interest without pretending stocks are clean
- broad risk-off + worsening macro odds = become more selective across both books


### What to do
Map the combined overlay into a lightweight posture adjustment:
- `lean_more_aggressive`
- `no_change`
- `lean_more_selective`

### Purpose
This should influence:
- how picky we are
- how much confirmation we require
- how much we trust follow-through

### Example
- confirmed uptrend + supportive Polymarket = slightly more aggressive on valid setups
- correction + risk-on Polymarket = no aggression increase; maybe watchlist only
- degraded regime + rising recession/inflation risk = more selective

### Important
This is **not** position sizing logic by itself.
It is a decision-quality overlay.

---

## 7. Add theme persistence scoring

### What to do
Track whether a Polymarket theme is:
- one-off noise
- persistent over multiple runs
- accelerating
- reversing

### Why it matters
A one-print jump is less valuable than a theme that keeps building for 2-3 runs.

### Use
Persistent themes should get:
- higher mention priority
- more watchlist weight
- more attention in morning brief / session summary

---

## 8. Rank candidate trades by technical quality + macro relevance overlap

### Stage awareness to add
Every surfaced name should ideally be tagged as one of:
- `early`
- `actionable`
- `extended`
- `exhaustion risk`

That gives us a way to separate:
- names worth stalking or entering
- names that are working but too crowded to start
- names that may be approaching peak narrative saturation

Without this, the system risks finding the right story too late.


### What to do
Add a secondary ranking field for candidates:

`combined_priority = technical_rank + macro_relevance_bonus`

Where the macro bonus is small and bounded.

### Why it matters
This helps answer:
- which valid setups matter most **right now**?

### Example
If multiple names are technically fine:
- prefer the ones aligned with live macro/event shifts
- especially when the sector linkage is clean

### Guardrail
Macro bonus must be small enough that weak technicals never outrank strong technicals purely because of narrative heat.

---

## 9. Turn Polymarket into a “why now?” explainer

## 9a. Add a rapid ticker-check workflow

### What to do
If a ticker, coin, or crypto proxy comes up ad hoc in conversation, run a fast evaluation path that combines:
- the current backtester scripts
- the existing technical/regime stack
- Polymarket theme momentum and alignment/conflict context

### Why it matters
This lets us pressure-test ideas immediately instead of waiting for the stock to become popular or manually stitching together a thesis every time.

### Desired output
For any ticker, coin, or proxy mentioned, return a compact verdict like:
- `early / interesting`
- `actionable`
- `needs confirmation`
- `extended`
- `manage winners / exhaustion risk`
- `avoid for now`

### Example
- `HOOD: actionable — crypto-policy odds supportive, relative strength improving, still not badly extended`
- `ETH: actionable if momentum confirms — supportive crypto narrative, improving trend context, not a blind chase`
- `PLTR: strong but extended — good company, late setup, do not pretend this is early`


### What to do
Use it to improve alert commentary and operator trust.

### Why it matters
A lot of trading value is not just signal generation — it is understanding why a watchlist is changing.

### Example output
- “Fed easing odds improved, but equities remain in correction. Watch QQQ/NVDA for confirmation rather than forcing longs.”
- “Recession odds climbed again. Favor defensive leadership and treat small-cap strength skeptically unless breadth improves.”

This improves discipline.

---

## 10. Add retrospective usefulness scoring

### What to do
After enough history accumulates, review whether Polymarket overlays actually improved decisions.

### Questions to test
- Did supportive overlays help identify better watchlist names?
- Did conflicting overlays help us avoid forcing bad trades?
- Which themes were useful vs noisy?
- Which mappings deserve lower weight?

### Why it matters
This prevents narrative bloat and lets us prune bad logic.

---

## 11. Extend trading alerts to cover stocks and crypto together

### What to do
Upgrade the trading alert so it is no longer stock-only.

Each alert should be able to include:
- stock regime summary
- crypto regime summary
- key Polymarket trend shifts affecting either book
- stock watchlist / setups
- crypto watchlist / setups
- overlap commentary when the same theme drives both

### Why it matters
The operator should not need separate mental models or separate alert surfaces when the same macro or policy theme is pushing both stocks and crypto.

### Example
- `Stocks: correction, semis worth watching but no forcing`
- `Crypto: ETH improving, crypto-policy odds supportive, selective risk-on possible`
- `Overlap: COIN and HOOD benefit if crypto momentum continues`

### Guardrail
Do not let crypto excitement contaminate equity discipline, and do not let equity caution automatically suppress valid crypto-specific setups.

---

## 12. Add Coinbase-aware execution context

### What to do
Design the crypto side with the assumption that Coinbase is the practical execution venue.

### Why it matters
That means the system should prioritize:
- assets actually accessible on Coinbase
- practical spot-buy candidates first
- clear distinction between spot crypto trades and crypto-linked equity trades

### Implication
The product should be useful for: `can I buy more ETH here?`, not just `interesting chart, good luck nerd`.

---

## 13. Integrate Coinbase API data when available

### What to do
If Coinbase offers the needed public and/or account-level API access, integrate it into the strategy layer.

### Public-data use cases
Use Coinbase market data where useful for:
- supported asset discovery
- current prices
- volume / liquidity context
- tradable product metadata
- exchange-specific availability checks

### Authenticated use cases
If account access is enabled later, use Coinbase account data for:
- current balances and holdings
- cost basis or average entry context if available
- existing exposure to BTC / ETH / other assets
- alert personalization based on what is already owned
- basic execution feasibility checks

### Why it matters
This turns the crypto side from generic market commentary into something that understands:
- what can actually be bought
- what is already held
- whether a new crypto alert is additive, redundant, or too concentrated

### Guardrails
- start with read-only integration first
- no auto-trading in MVP
- no order placement without explicit later approval and separate design
- handle credentials securely and keep them out of logs/config sprawl

### Example benefits
- `ETH setup improving and you already hold size -> treat as add / hold / trim decision, not a generic fresh buy alert`
- `Coin not supported or not practical on Coinbase -> downgrade operational priority`
- `Crypto alert only surfaces coins you can actually buy on your venue`

---

## 14. Codex implementation guidance: tie into the existing backtester + Polymarket integration

### Goal
Codex should extend the system we already have instead of creating a new disconnected strategy path.

### Critical requirement
Reuse the existing flow where Polymarket context is already being fed into the current Python backtester alert pipeline.

Do **not** build:
- a second alert engine
- a second regime engine
- a separate one-off crypto analyzer that ignores the main stack
- a Polymarket-only strategy path

### Expected integration shape
Codex should wire the new features into the existing pipeline roughly like this:

1. **Backtester / regime engine remains primary**
   - continue using the current Python backtester and technical logic as the base decision layer

2. **Polymarket layer remains secondary**
   - keep Polymarket as context, divergence detection, watchlist enrichment, and conviction calibration

3. **Shared alert assembly**
   - use the existing alert/report path that already merges backtester output with Polymarket context
   - extend that path to support:
     - early-runway names
     - crypto sections
     - ticker/coin quick checks
     - Coinbase-aware crypto context

4. **One unified output surface**
   - one alert system that can speak about:
     - stocks
     - crypto
     - cross-asset theme overlap
   - not separate products pretending to be coordinated

### Specific Codex tasks
Codex should:
- identify the current backtester entrypoints and alert formatter
- identify the current Polymarket ingestion / mapping / merge points
- extend the existing merge logic rather than replacing it
- preserve current regime guardrails and alert behavior
- add new fields conservatively so old outputs do not break
- support both stock and crypto outputs from the same framework where practical

### Functional implementation targets
Codex should make it possible for the system to:
- rank stock setups with Polymarket context
- rank crypto setups with Polymarket context
- surface early-runway non-portfolio stocks
- surface early-runway crypto assets supported by Coinbase when possible
- return fast ad hoc verdicts for a ticker, coin, or proxy
- emit combined trading alerts that include both stock and crypto sections

### Architecture preference
Prefer extending:
- existing data models
- existing alert builders
- existing backtester wrappers
- existing watchlist logic

Avoid introducing a brand-new orchestration path unless there is a clear technical reason.

### Testing expectations
Codex should validate:
- current alert behavior still works when Polymarket is absent
- stock-only paths still render correctly
- crypto additions do not break equity outputs
- quick ticker/coin checks return structured stage labels
- overlap watchlists and divergence summaries remain concise and useful

### Practical note
I checked memory for the prior discussion about `yesterday` and the retrieval was low-confidence, so this guidance is based on the current repo intent and the already-described architecture: **reuse the existing backtester + Polymarket merged path, do not fork it into something cute and fragile.**

---

## Suggested Next Implementation Sequence

## Phase 1 — low-risk, high-value
1. Keep current integration live
2. Add overlap watchlist bucket
3. Add early-runway bucket for non-portfolio stocks and crypto assets
4. Add compact divergence/support/conflict summary
5. Add change-threshold highlighting
6. Add crypto section to the trading alert
7. Add Coinbase public-data integration if available

## Phase 2 — strategy enhancement
8. Add conviction modifier for already-valid setups
9. Add sector-priority routing based on active themes
10. Add crypto-regime routing based on active themes
11. Add theme persistence scoring
12. Add rapid ticker/coin checks
13. Add optional read-only Coinbase account context

## Phase 3 — validation
14. Add retrospective review of which themes improved outcomes
15. Tune weights and prune low-value mappings
16. Consider limited quantitative scoring if the data proves useful

---

## Concrete Ideas Worth Building First

## Best immediate upgrades

### A. Overlap watchlist
Show:
- `Technical + Polymarket overlap`
- `Polymarket-only watch`

This is probably the fastest value add.

### B. Conflict flag in alerts
If Polymarket says risk-on but regime is correction:
- prominently label it
- force patience

### C. Odds-move trigger summaries
Only mention Polymarket when:
- odds moved enough to matter
- or the theme is macro-critical

### D. Sector inspection routing
Use active themes to tell the scanner what to inspect first.

---

## Guardrails

## Never do these
- no direct BUY because of Polymarket alone
- no position size increase because of Polymarket alone
- no override of correction regime
- no reliance on thin novelty contracts
- no broad discovery without curation

## Always do these
- keep Polymarket secondary
- prefer change + quality + persistence over raw probability
- route into watchlists and confidence before strategy logic
- log which themes were actually useful over time

---

## My Recommendation

If we want the highest return on this new capability, the next move is:

1. **build an overlap watchlist across stocks and crypto**
2. **add an early-runway discovery bucket for non-portfolio names and crypto assets**
3. **add conflict/supportive conviction states to valid setups**
4. **add rapid ticker/coin checks using the current backtester + Polymarket context**
5. **add crypto strategy sections to the trading alert alongside stocks**
6. **integrate Coinbase public data, then optional read-only account context**
7. **prioritize sector inspection and crypto-regime inspection based on live Polymarket themes**
8. **review usefulness after enough history accumulates**

That gives us more context, earlier discovery, better prioritization, venue-aware crypto usefulness, and better discipline — without turning the strategy into a prediction-market clown car with ETH bags.

---

## What Else We Can Use the Polymarket API For

Polymarket should not just feed the stock strategy. There are several other useful ways to exploit it as a probability layer across the stack.

## 1. Morning brief / market session briefing

Use Polymarket to enrich daily briefings with:
- top macro odds
- biggest 24h changes
- support/conflict versus the current regime
- event-sensitive sectors to watch at the open

This is probably the cleanest non-trading use.

---

## 2. Event-risk dashboarding

Track specific risk buckets over time:
- recession risk
- inflation risk
- Fed policy odds
- geopolitical escalation
- election/policy themes
- crypto policy themes

This can become a lightweight internal risk board for:
- what the crowd is pricing
- what changed recently
- where regime conflict is building

---

## 3. Narrative shift detection

Use the API to detect when the crowd meaningfully reprices a narrative before it fully shows up elsewhere.

Examples:
- sudden easing repricing
- sudden inflation repricing
- election or tariff repricing
- geopolitical escalation repricing

This is useful for:
- preparing the watchlist earlier
- adjusting what sectors we inspect first
- improving explanation quality in alerts and briefs

---

## 4. Triggered alerts outside the stock scanner

We can build standalone event alerts like:
- “Fed easing odds moved +8 pts in 24h”
- “Geopolitical escalation odds crossed 30%”
- “Recession odds are accelerating for a second straight run”

These should be **intelligence alerts**, not trade alerts.

---

## 5. Macro regime cross-checking

Use Polymarket as an external cross-check against:
- price-based regime
- news sentiment
- X/Twitter sentiment
- economic calendar expectations

This helps identify:
- consensus alignment
- narrative divergence
- spots where the tape may be underreacting or overreacting

---

## 6. Historical research and backtesting ideas

Once enough snapshots accumulate, the API data can support:
- retrospective studies of odds shifts vs SPY/QQQ/sector reactions
- which themes lead vs lag the tape
- which Polymarket categories are useful vs noisy
- whether conflict states improve decision quality

This is where the real compounding value may show up.

---

## 7. Sector and ticker sensitivity maps

Over time we can build internal maps like:
- easing-sensitive names
- inflation-sensitive names
- recession-sensitive names
- geopolitical-sensitive names
- crypto-policy-sensitive names

That turns Polymarket into a reusable event-to-equity translation layer.

---

## 8. Better autonomous monitoring

Polymarket can feed autonomous monitoring for:
- unusual macro repricing
- hidden regime conflict
- event clusters worth escalating
- alert prioritization for market open / close

Useful rule:
only escalate when the market is both **relevant** and **moving enough to matter**.

---

## 9. Portfolio risk commentary

Even without auto-trading, Polymarket can improve portfolio commentary by saying:
- what macro risks are rising
- what themes are helping or hurting current exposure
- where the crowd’s pricing is moving against the current book

That is useful for discipline and de-risking discussions.

---

## 10. General-purpose probability intelligence layer

Beyond trading, Polymarket can become a general forecasting source for:
- elections and policy
- crypto regulation
- macro event odds
- geopolitics
- specific event calendars where crowd pricing is informative

Meaning: this can become an all-purpose **probability intelligence service** inside Cortana, not just a trading feature.

---

## My Recommendation on Broader Use

The best adjacent uses after trading integration are:
1. **daily brief / market session enrichment**
2. **macro/event alerting**
3. **historical research on odds shifts vs market behavior**
4. **portfolio risk commentary**

Those give a lot of value without needing to overengineer anything.

---

## One-Line Summary

**Best use of Polymarket: make the existing strategy smarter about context, priority, and caution — and use the API more broadly as a probability intelligence layer across market briefs, alerts, and research.**
