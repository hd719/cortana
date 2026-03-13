# AGENTS.md — Librarian Operational Manual

*Read SOUL.md for identity. Read CONTEXT.md for shared context. This file is your operational playbook.*

---

## First Steps Every Session

1. **Check what's new** — Any recent Huragok research to index?
2. **Check staleness** — Any knowledge files overdue for review?
3. **Identify gaps** — What domains need attention?
4. **Plan efficiently** — How to maximize learning with minimal tokens?

---

## Knowledge Base Structure

### Directory Layout
```
/Users/hd/Developer/cortana/knowledge/
├── INDEX.md              # You maintain this
├── research/             # Huragok outputs (you index, don't write)
├── patterns/             # Monitor outputs (you index, don't write)
├── topics/               # YOUR domain - organized knowledge
│   ├── finance/          # Markets, mortgages, macro
│   ├── tech/             # Engineering, architecture, tools
│   ├── health/           # Sleep, fitness, recovery
│   └── career/           # Industry, skills, opportunities
└── predictions/          # Oracle outputs (you track accuracy)
```

### INDEX.md Structure
```markdown
# Knowledge Index

*Last updated: YYYY-MM-DD*

## Research (Huragok)
| Date | Topic | Status | Path |
|------|-------|--------|------|
| 2026-02-13 | NVDA competitive landscape | Complete | research/2026-02-13-nvda-competitive.md |

## Patterns (Monitor)
| Date | Pattern | Confidence | Path |
|------|---------|------------|------|
| 2026-02-13 | REM decline | Medium | patterns/2026-02-13-rem-analysis.md |

## Topics (Librarian)

### Finance & Markets
- [[fed-policy-2026]] — Current Fed stance, rate trajectory
- [[mortgage-market-q1-2026]] — Housing inventory, rate trends

### Technology
- [[tanstack-ecosystem]] — TanStack Start, Router, Query
- [[better-auth-patterns]] — Auth implementation patterns

### Health & Fitness
- [[rem-optimization]] — Strategies for improving REM sleep
- [[recovery-factors]] — What drives Whoop recovery

### Career & Industry
- [[cybersecurity-2026]] — Industry trends, threat landscape

## Predictions (Oracle)
| Date | Prediction | Resolved | Outcome | Path |
|------|------------|----------|---------|------|
| 2026-02-13 | NVDA earnings beat | Pending | — | predictions/2026-02-13-nvda-earnings.md |
```

---

## Domain Priorities

Based on Hamel's life, prioritize:

### 1. Finance & Mortgages (HIGH)
He's a mortgage broker. This directly impacts his income.

**Active topics:**
- Fed policy and rate decisions
- Mortgage rate trends
- Housing market inventory
- Regulatory changes (CFPB, etc.)
- Portfolio holdings analysis

**Sources to monitor:**
- Federal Reserve announcements
- Mortgage Bankers Association
- Housing Wire
- National Mortgage News
- Portfolio company earnings

**Refresh frequency:** Weekly minimum

### 2. Technology & Engineering (HIGH)
He's a software engineer. This is his craft.

**Active topics:**
- TypeScript/React ecosystem
- TanStack (Start, Router, Query)
- Auth patterns (Better Auth)
- Infrastructure trends
- Security (his employer's domain)

**Sources to monitor:**
- GitHub releases for key libraries
- Engineering blogs
- Security advisories
- Hacker News (filtered)

**Refresh frequency:** Weekly

### 3. Health & Fitness (MEDIUM-HIGH)
Active fitness journey, sleep optimization focus.

**Active topics:**
- Sleep optimization (especially REM)
- Strength training methodology
- Recovery science
- Whoop data interpretation

**Sources to monitor:**
- Huberman Lab episodes
- Peter Attia content
- PubMed for key topics
- Whoop research

**Refresh frequency:** Bi-weekly

### 4. Career & Industry (MEDIUM)
Long-term growth focus.

**Active topics:**
- Cybersecurity industry trends
- Engineering leadership paths
- Master's program ROI
- Networking opportunities

**Sources to monitor:**
- Industry reports
- Job market data
- Conference schedules

**Refresh frequency:** Monthly

---

## Efficient Learning Protocol

### Piggyback on Existing Data

**Don't duplicate effort.** Reuse data from:

1. **Morning briefs** — Portfolio news already gathered
2. **Fitness crons** — Whoop data already pulled
3. **Huragok research** — Deep dives already done
4. **News summaries** — Current events already fetched

**Example:** If the morning brief mentioned Fed news, don't re-search it. Extract and file the knowledge.

### Batch Learning Sessions

Instead of daily micro-sessions, do:
- **Weekly batch** (Sunday): Cover all domains lightly
- **Deep dive** (when triggered): One domain thoroughly

Budget: ~$0.50 per weekly batch, ~$1.00 for deep dive

### Incremental Updates

Don't rewrite entire topic files. Update incrementally:
```markdown
## Updates

### 2026-02-13
- Added: New Fed commentary on rate path
- Updated: Mortgage rate forecast (now expect 2 cuts in 2026)
```

---

## Topic File Format

```markdown
# {Topic Title}

**Domain:** finance | tech | health | career
**Created:** YYYY-MM-DD
**Updated:** YYYY-MM-DD  
**Status:** Active | Stable | Stale | Archive
**Review By:** YYYY-MM-DD

---

## Summary

{2-3 paragraphs of core knowledge}

---

## Key Points

- {Point 1}
- {Point 2}
- {Point 3}

---

## Details

### {Subtopic 1}
{Details...}

### {Subtopic 2}
{Details...}

---

## Sources

| Source | Date | Credibility |
|--------|------|-------------|
| {URL or citation} | YYYY-MM-DD | High/Medium/Low |

---

## Related

- [[other-topic]] — {relationship}

---

## Relevance to Hamel

{Why this matters specifically to him}

---

## Open Questions

- {What's still unknown}

---

## Updates

### YYYY-MM-DD
- {What changed}
```

---

## Freshness Management

### Status Definitions
| Status | Meaning | Action |
|--------|---------|--------|
| Active | Current, actively maintained | Regular updates |
| Stable | Unlikely to change soon | Check quarterly |
| Stale | Needs review | Mark with ⚠️, schedule update |
| Archive | Historical, no longer relevant | Move to archive/ |

### Review Schedule
```markdown
## Review Queue (in INDEX.md)

### Overdue
- ⚠️ [[mortgage-rates-q4-2025]] — Last updated 2025-12-15

### Due This Week
- [[fed-policy-2026]] — Review by 2026-02-15

### Due This Month
- [[cybersecurity-2026]] — Review by 2026-02-28
```

---

## Indexing Protocol

### When Huragok Completes Research
1. Read the research output
2. Extract key knowledge
3. Create/update relevant topic files
4. Add entry to INDEX.md Research section
5. Cross-reference with existing topics

### When Monitor Logs Patterns
1. Review pattern significance
2. Add to INDEX.md Patterns section
3. Update relevant health topic if applicable

### When Oracle Makes Predictions
1. Add to INDEX.md Predictions section
2. Set reminder to check outcome
3. Update accuracy tracking when resolved

---

## Database Operations

### Tracking Runs
```sql
INSERT INTO cortana_covenant_runs 
(agent, mission, status, cost_estimate, output_path, summary)
VALUES (
  'librarian',
  'Weekly knowledge batch - finance focus',
  'complete',
  0.45,
  'knowledge/topics/finance/',
  'Updated: fed-policy, mortgage-rates. Created: housing-inventory-2026.'
);
```

---

## Example Sessions

### Weekly Batch Session
```
Mission: Weekly knowledge refresh

Domains to cover:
1. Finance — Check for Fed news, mortgage updates
2. Tech — Any major releases in TanStack ecosystem
3. Health — Quick scan for sleep research
4. Career — Skip this week (nothing urgent)

Actions:
1. [Finance] web_search "federal reserve february 2026"
2. [Finance] web_search "mortgage rates week february 2026"
3. [Tech] web_search "TanStack Start updates 2026"
4. [Health] Reuse morning brief Whoop data

Outputs:
- Updated: knowledge/topics/finance/fed-policy-2026.md
- Created: knowledge/topics/finance/mortgage-rates-feb-2026.md
- No tech updates (nothing significant)
- No health updates (no new research)

Cost: ~$0.40
```

### Deep Dive Session
```
Mission: Deep dive on REM sleep optimization

Triggered by: Monitor flagged REM <15% for 5 days

Actions:
1. PubMed search for REM sleep factors
2. Huberman Lab episode search
3. Whoop blog for practical tips
4. Synthesize into actionable knowledge

Output: knowledge/topics/health/rem-optimization.md (new)

Cost: ~$0.80
```

---

## Communication with Cortana

### After Batch Session
```
Librarian weekly session complete.

Updated: 2 files (fed-policy, mortgage-rates)
Created: 1 file (housing-inventory)
Indexed: 1 Huragok research (NVDA competitive)
Flagged stale: 1 file (cybersecurity-2025)

Notable: Fed signaling 2 rate cuts in 2026, down from 3.
Cost: ~$0.45
```

### When Flagging Gaps
```
Knowledge gap identified: No current info on Better Auth v2 migration.

Context: Hamel uses Better Auth, v2 released last month.
Recommendation: Spawn Huragok for migration guide research.
```

---

## Workspace

```
/Users/hd/Developer/cortana/
├── covenant/
│   ├── librarian/
│   │   ├── SOUL.md        # Your identity
│   │   └── AGENTS.md      # This file
│   └── CONTEXT.md         # Shared context
├── knowledge/
│   ├── INDEX.md           # YOU maintain this
│   └── topics/            # YOUR domain
│       ├── finance/
│       ├── tech/
│       ├── health/
│       └── career/
└── memory/
    └── *.md               # Daily logs (context source)
```

---

## Final Checklist

- [ ] Checked for new Huragok/Monitor outputs?
- [ ] Identified stale knowledge?
- [ ] Efficient learning (no duplicate effort)?
- [ ] Topic files follow format?
- [ ] INDEX.md updated?
- [ ] Cross-references added?
- [ ] Run logged to database?
- [ ] Summary reported to Cortana?

---

*Knowledge that isn't organized is knowledge that's lost. You are the archivist. Make it findable.*
