# Polymarket-Enhanced Market Intelligence for US Equities

**Status:** Draft  
**Owner:** Cortana / Market Intel  
**Audience:** Hamel, trading pipeline maintainers, future market-intel agents  
**Last Updated:** 2026-03-13

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Problem](#problem)
3. [Goals](#goals)
4. [Non-Goals](#non-goals)
5. [Users](#users)
6. [User Stories](#user-stories)
7. [Product Principles](#product-principles)
8. [Scope](#scope)
9. [Key Product Questions](#key-product-questions)
10. [Market Categories](#market-categories)
11. [Data Sources](#data-sources)
12. [Functional Requirements](#functional-requirements)
13. [Non-Functional Requirements](#non-functional-requirements)
14. [Proposed Architecture](#proposed-architecture)
15. [Data Model](#data-model)
16. [Output Formats](#output-formats)
17. [UX and Behavior Requirements](#ux-and-behavior-requirements)
18. [Ranking and Scoring](#ranking-and-scoring)
19. [Decision Rules](#decision-rules)
20. [Success Metrics](#success-metrics)
21. [Risks and Mitigations](#risks-and-mitigations)
22. [Security and Compliance](#security-and-compliance)
23. [Implementation Plan](#implementation-plan)
24. [Suggested Repo Artifacts](#suggested-repo-artifacts)
25. [Open Questions](#open-questions)
26. [Recommendation](#recommendation)

---

## Executive Summary

Build a **Polymarket-enhanced market intelligence layer** that augments the current US equity analysis pipeline with:

- prediction-market probabilities
- macro event odds
- narrative-risk shifts
- event-sensitive watchlist context

This system is **not** a trade engine and **not** a primary source of truth. It is a **secondary context layer** that helps answer:

- What is the crowd pricing in right now?
- Which macro or event probabilities changed materially?
- Do those changes support or conflict with the current equity regime?
- Which sectors and stocks should be watched more closely because event odds moved?

### Core philosophy

- **Stocks data drives action**
- **Polymarket adds context**
- **Regime and risk controls stay in charge**

### Why this matters

Our current stack is strong on technical/regime logic, but weaker at turning macro/event probability shifts into useful stock-market context. This product closes that gap without turning the system into a narrative-chasing mess.

---

## Problem

The current stock analysis stack is strong at:

- technical and regime interpretation
- scanner outputs
- risk gating
- buy/watch/no-buy decisions

It is weaker at:

- translating macro event probabilities into equity context
- detecting narrative shifts early
- quantifying what the crowd expects around catalysts
- surfacing event-driven risks before they fully show up in price action

### Current gaps

- Fed odds shift sharply, but alerts only say `correction`
- recession odds rise, but sector implications are not surfaced cleanly
- policy odds move, but the system does not map them into stock or sector watchlists
- narrative-sensitive names only become obvious after charts already deteriorate or improve

### Result

The current system can be technically correct but context-poor.

---

## Goals

Create a disciplined, explainable integration that uses Polymarket to enrich US stock analysis with:

1. **Macro probability signals**
2. **Event-driven market and sector context**
3. **Narrative confirmation or divergence**
4. **Actionable watchlist intelligence**
5. **Probability-change monitoring**

### The product should help answer

- Which Polymarket markets matter most for the S&P 500 and Nasdaq right now?
- Did prediction-market odds move before the tape?
- Do those odds strengthen or weaken the current stock-market read?
- Which sectors and names deserve attention because event probabilities shifted?

---

## Non-Goals

This system will **not**:

- place trades on Polymarket
- use Polymarket as a direct BUY trigger
- override equity regime controls
- replace technical or fundamental stock analysis
- rely on low-liquidity meme markets as serious signals
- treat prediction markets as truth instead of crowd-priced probability
- trade individual stocks solely because a macro-event odds line moved

---

## Users

### Primary user

- **Hamel**
  - wants sharper market context
  - wants useful watchlists instead of dead-air outputs
  - wants practical signal fusion rather than dashboard theater

### Secondary users

- future autonomous alerting agents
- market-session briefing flows
- market-intelligence tooling maintainers

---

## User Stories

### Macro context
As a user, I want to see key Polymarket macro odds next to stock-market analysis so I know what the crowd is pricing.

### Risk overlay
As a user, I want alerts to say whether Polymarket is risk-on, neutral, or risk-off relative to equities.

### Narrative conflict detection
As a user, I want to know when Polymarket and stocks are diverging so I can treat that as warning or opportunity context.

### Watchlist support
As a user, I want event-sensitive names and sectors surfaced when odds shift, so I get real watchlist candidates.

### Event monitoring
As a user, I want to track changes in important markets over time, not just current odds snapshots.

### Decision hygiene
As a user, I want Polymarket used as context, not as an excuse to force trades.

---

## Product Principles

1. **Probability, not prophecy**  
   Polymarket is a crowd-priced forecast, not truth.

2. **High-liquidity first**  
   Prefer markets with meaningful volume, liquidity, and clear resolution conditions.

3. **Explainability over magic**  
   Every output should say why a Polymarket signal matters.

4. **Secondary signal only**  
   Market structure and equity evidence remain primary.

5. **Macro first, stock second**  
   Start with macro and event overlays before trying stock-specific mapping.

6. **Watchlist utility over signal theater**  
   If there is no BUY, the system should still produce useful watch names and context.

---

## Scope

### Phase 1: Read-only intelligence layer

Build a read-only Polymarket intelligence layer that:

- fetches relevant Polymarket markets and events
- filters to a curated set of stock-relevant contracts
- normalizes odds, liquidity, and recent changes
- classifies impact on US equities
- generates:
  - macro snapshot
  - regime support/conflict overlay
  - sector watch implications
  - event-sensitive stock watchlist notes

### Phase 2: Pipeline integration

Add:

- odds-change tracking
- alert thresholds
- event calendar awareness
- historical comparison against SPY, QQQ, and sector moves
- weighting into market-session summaries

### Phase 3: Historical analytics and refinement

Potential additions:

- backtesting of Polymarket-derived overlays
- stock and sector sensitivity modeling
- richer dashboarding
- persistent warehouse or database-backed history

---

## Key Product Questions

At any given time, the product should answer:

1. Which Polymarket markets matter most for US stocks?
2. What are the current implied probabilities?
3. What changed materially over 1h, 4h, and 24h?
4. Does that shift support or conflict with the current market regime?
5. Which sectors are most exposed?
6. Which individual watchlist names are most relevant?
7. Is the signal strong enough to mention, or just noise?

---

## Market Categories

### 1. Macro and rates
Examples:

- Fed rate cuts or hikes by next meeting
- inflation or CPI direction
- recession odds
- unemployment or labor stress
- yield-related proxies, where relevant
- hard landing vs soft landing narrative markets

Use cases:

- growth vs value interpretation
- tech multiple sensitivity
- risk appetite context
- cyclicals vs defensives

### 2. Political and policy
Examples:

- election odds
- House, Senate, or Presidency control
- policy outcomes affecting:
  - energy
  - healthcare
  - crypto
  - defense
  - tariffs or trade

Use cases:

- sector-specific overlays
- medium-term risk framing

### 3. Geopolitical and event risk
Examples:

- escalation odds
- sanctions-related developments
- shutdown or default-style event risk
- commodity shock events

Use cases:

- energy, defense, airlines, industrials, semis, broad risk-off context

### 4. Sector-relevant narrative markets
Examples:

- AI regulation
- crypto policy or approval markets
- EV policy or tariff themes
- energy price and macro-demand proxies

Use cases:

- NVDA, AMD, MSFT, META, TSLA, COIN, MARA, energy names, and related sector watchlists

---

## Data Sources

### Primary external source

- **Polymarket API / docs**
  - event discovery
  - market discovery
  - prices or probabilities
  - market metadata
  - liquidity or volume, where available
  - status and market activity metadata

### Internal sources

- current trading pipeline
- scanner outputs
- market-session alert formatter
- watchlist generation logic
- any existing market-intel tooling already in repo

### Optional future sources

- stock price and volume feeds
- economic calendar
- X/Twitter sentiment
- headline/news inputs
- earnings calendar

---

## Functional Requirements

### FR1. Market discovery
The system shall fetch Polymarket events and markets and identify contracts relevant to US equities.

#### Requirements

- support event and category filtering
- support keyword matching
- support curated allowlists
- exclude irrelevant novelty markets

#### Acceptance criteria

- the system returns a candidate set of stock-relevant markets from a broader feed

---

### FR2. Curated market registry
The system shall maintain a curated registry of approved Polymarket mappings.

#### Required fields

- `market_id`
- `event_id`
- `slug`
- `title`
- `category`
- `theme`
- `equity_relevance`
- `sector_tags`
- `watch_tickers`
- `confidence_weight`
- `min_liquidity`
- `active`
- `notes`

#### Why this exists

- prevents the system from hallucinating relevance from garbage markets
- gives us human control over what influences alerts

#### Acceptance criteria

- only approved or rule-qualified markets influence production output

---

### FR3. Market quality filter
The system shall score and filter markets by quality.

#### Inputs

- liquidity
- volume
- spread or midpoint sanity, where available
- recency
- clarity of resolution condition
- event relevance
- duplicate-market consolidation

#### Output

- `high`
- `medium`
- `low`
- `ignore`

#### Rules

- low-liquidity or ambiguous markets should not materially influence alerts
- if market quality is poor, either downgrade confidence or suppress output

#### Acceptance criteria

- thin or joke markets do not pollute production outputs

---

### FR4. Normalized probability snapshot
The system shall normalize relevant market data into a stable internal structure.

#### Example

```json
{
  "source": "polymarket",
  "marketId": "abc123",
  "title": "Will the Fed cut rates by June?",
  "theme": "rates",
  "probability": 0.64,
  "change1h": 0.03,
  "change24h": 0.11,
  "volume24h": 1200000,
  "liquidityScore": 0.82,
  "qualityTier": "high",
  "equityImpact": "bullish-duration",
  "sectorTags": ["tech", "small-cap", "growth"],
  "watchTickers": ["QQQ", "IWM", "ARKK", "NVDA", "TSLA"]
}
```

#### Acceptance criteria

- downstream code consumes a stable schema instead of raw API-specific shapes

---

### FR5. Odds change detection
The system shall detect significant changes in relevant markets.

#### Change windows

- 1 hour
- 4 hours
- 24 hours

#### Example triggers

- Fed cut odds +8 points in 24h
- recession odds +10 points in 24h
- election or policy odds crossing key thresholds

#### Acceptance criteria

- notable moves generate candidate annotations for reports and watchlists

---

### FR6. Equity impact mapping
The system shall map Polymarket markets to market and sector implications.

#### Examples

- higher recession odds -> risk-off, defensives stronger, cyclicals weaker
- higher Fed cut odds -> bullish for duration and growth if not driven by crisis
- geopolitical escalation -> energy and defense stronger, airlines and risk assets weaker
- crypto-friendly policy odds -> crypto proxy strength watch

#### Each mapping should include

- `market_bias`
- `regime_effect`
- `sector_implications`
- `ticker_watch_implications`
- `caveats`

#### Acceptance criteria

- output is intelligible and tied to actual sector and ticker implications

---

### FR7. Conflict and confirmation engine
The system shall compare Polymarket-derived signals with equity regime signals.

#### Example states

- easing odds improving while equities remain in correction -> `conflicts`
- recession odds rising while breadth weakens -> `confirms`
- policy odds favorable for semis while semis break down technically -> `mixed` or `conflicts`

#### Output values

- `confirms`
- `conflicts`
- `neutral`
- `insufficient_data`

#### Acceptance criteria

- alerts explicitly say whether Polymarket agrees with or conflicts with the tape

---

### FR8. Watchlist enrichment
The system shall generate watchlist context from relevant Polymarket themes.

#### In correction mode

- do not force BUYs
- do surface event-sensitive watch names

#### Example outputs

- `Polymarket shift: Fed-cut odds +9 pts/24h -> watch QQQ, IWM, NVDA, AMD for relative strength`
- `Geopolitical escalation odds rising -> watch XOM, CVX, LMT; avoid airlines and fragile beta`

#### Acceptance criteria

- the user gets practical sectors and names to monitor

---

### FR9. Market-session snapshot integration
The system shall integrate Polymarket context into market-session alerts.

#### New sections

- `Polymarket Macro`
- `Odds Shift`
- `Supports / Conflicts`
- `Event-Sensitive Watchlist`

#### Example

```text
Polymarket: Fed-cut odds 64% (+8 pts/24h), recession odds 37% (+5 pts/24h)
Overlay: mixed — easing odds support growth, recession odds cap aggression
Watchlist: NVDA, AMD, IWM, XLU
```

#### Acceptance criteria

- the alert remains concise but becomes materially more useful

---

### FR10. Detailed analysis output
The system shall support a verbose report mode.

#### Use cases

- `give me detailed market analysis`
- `why are we watching these names?`
- `what is Polymarket saying right now?`

#### Report sections

- top relevant markets
- change table
- equity implications
- sectors at risk or opportunity
- conflicts with current technical regime
- recommended watchlist

#### Acceptance criteria

- the user can request a deeper brief beyond cron-sized alerts

---

### FR11. Historical storage
The system shall store snapshots over time for comparison and later review.

#### Persist

- timestamp
- market id
- probability
- change windows
- liquidity and quality
- derived tags

#### Use cases

- compare current vs morning or prior day
- detect acceleration in sentiment changes
- backtest usefulness later

#### Acceptance criteria

- the system can answer `what changed since this morning?`

---

### FR12. Safe fallback behavior
If Polymarket is unavailable or low quality:

- stock analysis continues
- the alert omits or downgrades the Polymarket section
- no false precision is presented
- the market pipeline should not hard-fail because Polymarket is absent

#### Acceptance criteria

- Polymarket does not become a new single point of failure

---

## Non-Functional Requirements

### Reliability

- read-only integration
- bounded timeouts
- retries with backoff
- cached recent responses
- graceful partial-failure handling

### Explainability

Every notable claim should tie back to:

- a specific market
- current probability
- recent change
- the equity interpretation

### Latency

Target performance:

- cached snapshot path: **< 2s**
- fresh fetch path: **< 10s** preferred

### Maintainability

- curated mappings live in editable config or JSON
- stable schemas
- modular derivation logic
- strong test coverage for impact rules

### Observability

- log fetch success or failure
- log rejected markets and why
- log quality downgrades
- log major odds-shift triggers

---

## Proposed Architecture

### A. Ingestion layer
Fetches raw Polymarket data:

- events
- markets
- prices or probabilities
- metadata

### B. Registry / mapping layer
Curated files that map markets or themes to equity relevance.

**Suggested file:**

- `config/market-intel/polymarket-registry.json`

### C. Normalization layer
Transforms raw API output into a stable internal schema.

### D. Signal engine
Computes:

- quality scores
- probability changes
- impact tags
- support or conflict states

### E. Alert formatter
Injects Polymarket-derived context into:

- market-session snapshots
- verbose analysis reports
- watchlist sections

### F. Persistence layer
Stores snapshots and derived results.

**Suggested directories:**

- `var/market-intel/polymarket/`
- `var/market-intel/polymarket/history/`

---

## Data Model

### 1. Raw market snapshot

```json
{
  "fetchedAt": "2026-03-14T00:00:00Z",
  "source": "polymarket",
  "eventId": "evt_123",
  "marketId": "mkt_456",
  "title": "Will the Fed cut rates by June?",
  "slug": "fed-cut-june",
  "status": "active",
  "probability": 0.64,
  "volume24h": 1200000,
  "liquidity": 850000,
  "qualityInputs": {
    "spreadOk": true,
    "active": true,
    "recentTrade": true
  }
}
```

### 2. Curated mapping record

```json
{
  "slug": "fed-cut-june",
  "theme": "rates",
  "equityRelevance": "high",
  "sectorTags": ["growth", "tech", "small-cap"],
  "watchTickers": ["QQQ", "IWM", "NVDA", "AMD", "TSLA"],
  "impactModel": "fed_cut_odds",
  "confidenceWeight": 0.9,
  "minLiquidity": 250000,
  "active": true
}
```

### 3. Derived signal

```json
{
  "theme": "rates",
  "title": "Will the Fed cut rates by June?",
  "probability": 0.64,
  "change24h": 0.08,
  "qualityTier": "high",
  "equityImpact": {
    "marketBias": "bullish-growth",
    "regimeEffect": "risk-on",
    "sectorImplications": [
      "supports long-duration tech",
      "supports small-cap beta"
    ],
    "watchTickers": ["QQQ", "IWM", "NVDA", "AMD"]
  },
  "alignment": "conflicts",
  "alignmentReason": "Polymarket easing impulse improving, but equities remain in correction."
}
```

---

## Output Formats

### Compact market-session add-on

```text
Polymarket: Fed-cut odds 64% (+8 pts/24h), recession odds 37% (+5 pts/24h)
Overlay: mixed — easing odds support growth, recession odds keep regime fragile
Watchlist: NVDA, AMD, IWM, GOOGL
```

### Verbose brief

```text
Polymarket Macro Snapshot
- Fed cut by June: 64% (+8 pts/24h) [high quality]
- Recession in 2026: 37% (+5 pts/24h) [medium quality]
- Geopolitical escalation: 29% (+7 pts/24h) [medium quality]

Interpretation
- Growth-supportive rates expectations are improving
- Recession and geopolitics prevent full risk-on confirmation
- Net: mixed macro backdrop; better for watchlist building than aggressive buying

Sector Impact
- Positive: large-cap growth, semis, selective software
- Neutral/mixed: consumer discretionary
- Negative/risk-sensitive: airlines, cyclicals, weak-breadth beta

Watchlist
- NVDA, AMD, MSFT, GOOGL, IWM
```

### Trigger alert

```text
Polymarket shift detected:
- Fed-cut odds +10 pts in 24h
- Recession odds +7 pts in 24h

Equity takeaway:
- conflicting macro message; avoid broad aggression
- watch QQQ, IWM, NVDA for relative-strength confirmation
```

---

## UX and Behavior Requirements

### Compact alerts

- concise enough for Telegram-sized delivery
- include only the top 1-3 relevant markets
- only surface if quality and impact thresholds are met

### Detailed reports

- available on demand
- structured and readable
- include caveats and confidence

### Tone

- practical
- no fake certainty
- no `Polymarket says buy` nonsense
- emphasize support, conflict, and watchlist implications

---

## Ranking and Scoring

Each market should receive a composite score:

```text
final_score = relevance * quality * move_significance * timeliness * confidence_weight
```

### Components

- `relevance`: how equity-relevant the market is
- `quality`: liquidity, clarity, activeness
- `move_significance`: size of the odds move
- `timeliness`: how recent the move is
- `confidence_weight`: hand-curated trust weight

### Uses

The final score determines:

- whether the market is shown at all
- display order
- whether it qualifies for compact alerts or verbose-only output

---

## Decision Rules

### Include in compact alerts if

- relevance is high
- quality is at least medium
- the market had a significant odds move or is macro-critical
- the signal has a credible equity or sector linkage

### Exclude if

- liquidity is low
- the resolution condition is unclear
- it is a novelty or meme market
- there is no plausible equity linkage
- it duplicates a stronger market already being shown

### Watchlist rule

If a market has a strong enough score and clear stock or sector linkage, add related names to the watchlist, but keep compact outputs short.

---

## Success Metrics

### Product success

- market-session alerts become more useful and less context-blind
- Hamel gets actionable watchlists tied to macro-event shifts
- fewer `why are we watching this?` moments
- higher trust in explanation quality

### Operational metrics

- percent of successful data fetches
- percent of alerts with usable Polymarket sections
- false-positive or low-value mention rate
- average latency added to the alert pipeline
- number of useful watchlist names surfaced per week

### Qualitative success

- the user says it improves decision quality
- the system helps explain tape behavior before or while it happens
- alerts feel sharper, not noisier

---

## Risks and Mitigations

### R1. Garbage-in from low-quality markets
**Mitigation:** curated registry, quality filter, liquidity thresholds

### R2. Overfitting narratives
**Mitigation:** keep Polymarket secondary, emphasize support/conflict framing, never use it as a direct BUY trigger

### R3. Alert bloat
**Mitigation:** compact caps, ranking, verbose mode for deep dives

### R4. False confidence
**Mitigation:** show probability and change, not deterministic claims; attach quality and confidence context

### R5. API instability or docs drift
**Mitigation:** caching, graceful fallback, modular ingestion layer

### R6. Bad sector mappings
**Mitigation:** conservative curated mappings first, iterative review later

---

## Security and Compliance

- read-only external data integration only
- no market trading from this system
- no wallet or order functionality in MVP
- avoid any workflow that could be interpreted as automated betting
- keep any credentials out of logs and config sprawl if auth is ever required later

---

## Implementation Plan

### Phase 1: Foundation

1. Add curated registry file
2. Build fetcher for relevant Polymarket data
3. Normalize raw markets into internal schema
4. Add quality filter
5. Add impact mapping rules
6. Add verbose report generator

**Deliverable:** standalone Polymarket market-intel report

### Phase 2: Pipeline integration

1. Integrate into market-session alert flow
2. Add compact formatter
3. Add watchlist enrichment
4. Add support/conflict logic
5. Add persistence and history

**Deliverable:** production market-session alert enrichment

### Phase 3: Historical analytics and triggers

1. Add odds-shift monitoring
2. Add historical comparison views
3. Add event-driven alerts
4. Add retrospective usefulness review

**Deliverable:** ongoing Polymarket intelligence layer

---

## Suggested Repo Artifacts

### Code

- `tools/market-intel/polymarket-fetch.ts`
- `tools/market-intel/polymarket-normalize.ts`
- `tools/market-intel/polymarket-score.ts`
- `tools/market-intel/polymarket-impact-map.ts`
- `tools/market-intel/polymarket-report.ts`

### Config

- `config/market-intel/polymarket-registry.json`
- `config/market-intel/polymarket-rules.json`

### Data

- `var/market-intel/polymarket/latest.json`
- `var/market-intel/polymarket/history/*.json`

### Tests

- `tests/market-intel/polymarket-normalize.test.ts`
- `tests/market-intel/polymarket-impact-map.test.ts`
- `tests/market-intel/polymarket-report.test.ts`

---

## Open Questions

1. Which exact macro markets do we trust enough for MVP?
2. Do we want curated-only market selection for v1, or partial auto-discovery?
3. How much alert real estate should Polymarket get in production messages?
4. Should sector and ticker mappings be static first, dynamic later?
5. Should intraday odds-shift alerts exist, or only scheduled inclusion in reports?
6. Should Polymarket appear in the daily briefing, market-session alerts, or both?
7. Do we want an overall confidence score for the Polymarket overlay?
8. Should history live in files first, then move to Postgres later?

---

## Recommendation

Build this as a **curated, read-only, macro-first intelligence layer**.

Do **not** let it drive trades directly.

Use it to improve:

- market-session context
- risk framing
- watchlist generation
- explanation quality

### Bad version

- `Polymarket says buy semis`

### Good version

- `Prediction markets just shifted toward easing, but equities are still in correction. Do not force buys yet — watch NVDA, AMD, IWM, and GOOGL for confirmation.`

That version is useful, disciplined, and much less likely to turn the pipeline into a casino with TypeScript.
