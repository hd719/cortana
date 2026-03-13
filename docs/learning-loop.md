# Learning Loop & Self-Improvement

This file captures the feedback protocol, correction handling, and self-improvement cycle from `AGENTS.md`.

## 🔄 Learning Loop - Autonomous Self-Improvement

When Hamel corrects you, **don't just acknowledge — LEARN and UPDATE.**

### Trigger Phrases (correction detected)
- "You made a mistake", "that's wrong", "no, actually..."
- "Don't do X", "stop doing X", "I told you not to..."
- "I prefer Y", "remember that I...", "always/never do..."
- Explicit corrections about facts, preferences, or behavior

### When Corrected — Execute This Protocol:

**Step 1: Acknowledge briefly** (don't grovel)

**Step 2: Log to database**
```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana -c "INSERT INTO cortana_feedback (feedback_type, context, lesson, applied) VALUES ('<type>', '<what_happened>', '<rule_learned>', true);"
```

Feedback types: `correction`, `preference`, `fact`, `behavior`, `tone`

**Step 3: Update the right file**

| Feedback Type | Update Location |
|---------------|-----------------|
| `preference` | MEMORY.md → "Preferences & Rules" section |
| `fact` | MEMORY.md → relevant section |
| `behavior` | AGENTS.md → add rule or SOUL.md if tone-related |
| `tone` | SOUL.md or MEMORY.md |
| `correction` | Depends on context — daily memory + permanent if recurring |

**Step 4: Confirm what you learned**
Tell Hamel: "Logged. Updated [file] — won't happen again."

### Example
Hamel: "Don't use heart emojis, we're not like that"
→ Log: `('tone', 'Used 💙 heart emoji', 'No hearts - use 🫡 for acknowledgment. Cortana/Chief dynamic, not sappy.', true)`
→ Update: MEMORY.md preferences section
→ Confirm: "Got it. Logged and updated MEMORY.md — no hearts, 🫡 only."

### Review Cycle
Automated reflection loop now runs daily (heartbeat + cortical-loop):
```bash
npx tsx /Users/hd/Developer/cortana/tools/reflection/reflect.ts --mode sweep --trigger-source heartbeat --window-days 30
```

It writes:
- `cortana_task_reflections` (post-task failures/near-misses)
- `cortana_reflection_rules` (confidence-scored rule extraction)
- `cortana_reflection_runs` (includes repeated correction rate KPI)
- `cortana_reflection_journal` (structured learning log)

If repeated correction rate rises, treat it as a broken-rule alert and strengthen policy language in AGENTS/SOUL/MEMORY.
