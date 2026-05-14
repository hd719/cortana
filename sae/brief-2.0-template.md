# Brief 2.0 (AM/PM Unified)

Use this skeleton for both AM and PM brief cron jobs.

## 0) Preflight (quality gate)
```bash
/Users/hd/Developer/cortana/tools/alerting/cron-preflight.sh brief-2.0 pg gog fitness gateway || exit 1
```

## 1) Gather (prefer sitrep, fallback if stale)
- Fitness snapshot (Whoop/Tonal)
- Calendar next 48h via gog
- Portfolio snapshot + top movers
- Operational follow-ups: open human-required items and durable GitHub Issue links when present
- Breaking tech/tool news (OpenAI, Anthropic, OpenClaw, key infra)

## 2) Delta since last brief
Persist previous brief summary in `memory/brief-last.json` and show:
- What changed in fitness/recovery
- New calendar events or schedule shifts
- Portfolio movers vs prior brief
- Operational follow-up deltas (new open/new resolved/new human-action-required)
- New breaking items

## 3) Output sections
1. 🧠 Quick take (2-4 bullets)
2. 💪 Fitness
3. 📅 Calendar
4. 📈 Portfolio (snapshot + movers)
5. 🧾 Operational Follow-ups
6. 📰 Breaking Tech/Tools
7. 🔄 Delta since last brief

## 4) SQL snippets
```sql
-- Open human-required follow-ups
SELECT id, title, system, severity, due_at
FROM cortana_human_required_actions
WHERE status='open'
ORDER BY
  CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
  due_at ASC NULLS LAST,
  last_seen_at DESC
LIMIT 7;
```

## 5) AM/PM mode
- AM: add plan-of-day focus + market-open awareness
- PM: add day wrap + tomorrow prep
