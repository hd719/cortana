# Cortical Loop

Cortana's event-driven nervous system. Complements the SAE (which gathers world state 3x/day) with real-time signal detection and wake-on-event capability.

## Architecture

```
Signal Sources (Email, Calendar, Whoop, Portfolio, Chief Activity)
    │
    ▼ watchers (launchd, every 2-15 min)
    │
    ▼
cortana_event_stream (PostgreSQL event bus)
    │
    ▼ evaluator (every 5 min)
    │
    ├─ Match events against cortana_wake_rules
    ├─ Check suppress conditions (chief asleep? budget spent?)
    ├─ Check kill switch + daily wake cap
    │
    ▼
openclaw cron wake → LLM session → Act (message Chief, create task, etc.)
```

## Components

### Chief Model (`cortana_chief_model`)
Real-time model of Hamel's state: awake/asleep, energy level, focus mode, communication preference. Updated every 5 min by the chief-state watcher.

### Watchers (`watchers/`)
| Watcher | Interval | Source |
|---------|----------|--------|
| email-watcher.sh | 2 min | Gmail via gog |
| calendar-watcher.sh | 5 min | Google Calendar via gog |
| health-watcher.sh | 15 min | Whoop via localhost:3033 |
| portfolio-watcher.sh | 10 min | Stock analysis (market hours only) |
| chief-state.sh | 5 min | Session files + calendar + sitrep |

### Wake Rules (`cortana_wake_rules`)
Configurable rules that match events to wake decisions. Each rule has:
- **source/event_type**: what to match
- **priority**: 1 (critical) to 5 (informational)
- **weight**: 0.0-1.0, decays with negative feedback
- **suppress_when**: conditions to skip (e.g., chief asleep)

### Evaluator (`evaluator.sh`)
Runs every 5 min. Processes unprocessed events against rules. If matched, wakes the LLM with full context (chief model + sitrep + feedback).

## Kill Switch

```bash
bash ~/clawd/cortical-loop/toggle.sh  # Toggle on/off
```

Also auto-disables when daily wake cap (default: 10) is reached.

## Adding a New Watcher

1. Create `watchers/my-watcher.sh` — poll source, INSERT into `cortana_event_stream`
2. `chmod +x` it
3. Create LaunchAgent plist in `~/Library/LaunchAgents/com.cortana.watcher.my-watcher.plist`
4. `launchctl load` the plist

## Adding a New Wake Rule

```sql
INSERT INTO cortana_wake_rules (name, description, source, event_type, condition, priority, suppress_when)
VALUES ('my_rule', 'Description', 'source_name', 'event_type', '{"key": "value"}', 3, '{}');
```

## Logs

All in `~/clawd/cortical-loop/logs/`:
- `email-watcher.log`, `calendar-watcher.log`, etc.
- `evaluator.log`

## State Files

All in `~/clawd/cortical-loop/state/`:
- `email-last-ids.txt` — dedup email events
- `calendar-alerts-sent.txt` — dedup calendar alerts
- `health-last-recovery.txt` — dedup recovery updates
- `current-wake-prompt.txt` — last wake prompt sent

## Feedback Loop

Closes the learning loop. Cortana adapts behavior based on three signal types:

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Reactions   │  │  Behavioral  │  │  Corrections │
│  👍 👎 ❤️ 🔥  │  │  latency,    │  │  "don't",    │
│  😒          │  │  engagement  │  │  "stop",     │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └────────┬────────┴────────┬────────┘
                ▼                 ▼
     cortana_feedback_signals    cortana_feedback
                │                 │
                ▼                 ▼
          feedback-handler.sh   learning-loop.sh
                │                 │
                ▼                 ▼
        cortana_wake_rules     AGENTS.md / MEMORY.md
         (weight adjust)        (behavior change)
```

### Signal Types

| Signal | Source | Weight Delta |
|--------|--------|-------------|
| Positive (👍 ❤️ 🔥) | Reaction | +0.05 |
| Negative (👎 😒) | Reaction | -0.15 |
| No engagement (2h+) | Behavioral | -0.02 |
| Quick reply (<5 min) | Behavioral | +0.05 |
| Direct correction | cortana_feedback | -0.15 |

### Weight Mechanics
- **Floor:** 0.1 (never fully kills a rule)
- **Ceiling:** 2.0
- **Suppress threshold:** weight < 0.3 (evaluator skips the rule)
- **Auto-suppress:** 3+ negatives AND weight < 0.3 → rule disabled + Hamel notified

### Components
- `feedback-handler.sh` — processes feedback_signals, adjusts wake rule weights
- `watchers/behavioral-watcher.sh` — detects implicit signals (latency, engagement) every 30 min
- `learning-loop.sh` — daily pipeline (11 PM ET): applies corrections to AGENTS.md/MEMORY.md, detects repeated lessons

### Manual Weight Adjustment
```sql
-- Boost a rule
UPDATE cortana_wake_rules SET weight = 1.5 WHERE name = 'rule_name';

-- Re-enable suppressed rule
UPDATE cortana_wake_rules SET enabled = TRUE, weight = 1.0, negative_feedback = 0 WHERE name = 'rule_name';

-- View feedback signals
SELECT * FROM cortana_feedback_signals ORDER BY timestamp DESC LIMIT 10;
```

## Debugging

```bash
# Check events
psql cortana -c "SELECT * FROM cortana_event_stream ORDER BY timestamp DESC LIMIT 10;"

# Check chief model
psql cortana -c "SELECT * FROM cortana_chief_model;"

# Check rule stats
psql cortana -c "SELECT name, trigger_count, last_triggered, weight FROM cortana_wake_rules;"

# Check LaunchAgent status
launchctl list | grep com.cortana
```
