# Cron Verification Report

Generated: 2026-02-26T12:09:10-05:00
Jobs file: `config/cron/jobs.json`
Total jobs: **42**

## Symlink Check
- Expected: `~/.openclaw/cron/jobs.json` -> `/Users/hd/openclaw/config/cron/jobs.json`
- Actual: /Users/hd/.openclaw/cron/jobs.json is not a symlink
- Status: ❌ BROKEN

## Job Inventory + Verification
### 1. Morning brief (Hamel)
- ID: `489b1e20-1bb0-48e6-a388-c3cc1743a324`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '30 7 * * *'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (2):
  - ✅ `/Users/hd/openclaw/skills/telegram-usage/handler.js` (exists=True, exec=-, syntax=n/a)
  - ✅ `/Users/hd/openclaw/tools/earnings/check-earnings.sh` (exists=True, exec=x, syntax=ok)

### 2. Daily Auto-Update (notify Hamel)
- ID: `af9e1570-3ba2-4d10-a807-91cdfc2df18b`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '22 4 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 3. Weekday newsletter digest (Hamel)
- ID: `cf184acd-0c18-4a36-95f6-b33958d9e0f2`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 18 * * 1-5', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 4. Mac mini process summary (weekday mornings)
- ID: `40c14439-9166-4727-86be-eec867ef04d5`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '17 5,13,21 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/openclaw/skills/process-watch/process-watch` (exists=True, exec=x, syntax=n/a)

### 5. Calendar reminders → Telegram (ALL calendars)
- ID: `9401d91c-5fa0-43a6-a18e-01030f9e5ba5`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '7 6-23 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/openclaw/memory/calendar-reminders-sent.json` (exists=True, exec=-, syntax=n/a)

### 6. Fed FOMC statement watch (today)
- ID: `37e128e9-e698-40b6-b5a9-3e7c355edea7`
- Enabled: `False`
- Schedule: `at` `{'kind': 'at', 'at': '2026-01-28T19:05:00.000Z'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 7. X session healthcheck (bird)
- ID: `c5e30b34-c081-4e95-8a02-7c930ac4cae6`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 4,16 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/bin/birdx` (exists=True, exec=x, syntax=n/a)

### 8. Stock Market Brief (daily)
- ID: `a86ca3f9-38af-4672-ba3f-1911352f0319`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '45 7 * * 1-5'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (2):
  - ✅ `/Users/hd/openclaw/skills/stock-analysis` (exists=True, exec=x, syntax=n/a)
  - ✅ `/Users/hd/openclaw/tools/portfolio/config.md` (exists=True, exec=-, syntax=n/a)

### 9. 📊 COIN Earnings Reminder (Feb 12 AMC)
- ID: `bb1046bd-dc05-41df-acdb-c613aa180154`
- Enabled: `False`
- Schedule: `at` `{'kind': 'at', 'at': '2026-02-12T15:00:00.000Z'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 10. 📊 NVDA Earnings Reminder (Feb 25 AMC)
- ID: `97343a85-2db1-4aa0-b0e9-989527028be4`
- Enabled: `False`
- Schedule: `at` `{'kind': 'at', 'at': '2026-02-25T15:00:00.000Z'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 11. 🏋️ Fitness Morning Brief (Hamel)
- ID: `a519512a-5fb8-459f-8780-31e53793c1d4`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '3 8 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/openclaw/tools/fitness/morning-brief-data.sh` (exists=True, exec=x, syntax=ok)

### 12. 🌙 Fitness Evening Recap (Hamel)
- ID: `e4db8a8d-945c-4af2-a8d5-e54f2fb4e792`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '30 20 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 13. 📊 Weekly Fitness Insights (Sunday)
- ID: `5aa1f47e-27e6-49cd-a20d-3dac0f1b8428`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 20 * * 0', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 14. 🔧 Fitness service healthcheck
- ID: `661b21f1-741e-41a1-b41e-f413abeb2cdd`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 4,16 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/Developer/cortana-external/.env` (exists=True, exec=-, syntax=n/a)

### 15. 📰 Newsletter Alert (real-time)
- ID: `bfb6e34f-72fe-4d06-b3a9-a0bc8ad3c6c1`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '*/30 6-16 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/openclaw/memory/newsletter-alerted.json` (exists=True, exec=-, syntax=n/a)

### 16. 🌙 Bedtime Check (10pm ET)
- ID: `f478d19f-d3ff-4649-87e0-3170560f618f`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '18 22 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 17. 📚 HW/Quiz Due Today (Mar 4)
- ID: `7e2c7deb-6832-4616-9d8b-8d8d86280e5e`
- Enabled: `True`
- Schedule: `at` `{'kind': 'at', 'at': '2026-03-04T12:00:00.000Z'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 18. Amazon Session Keep-Alive
- ID: `a75c6231-9966-4fcf-a23d-8c1ca157b59a`
- Enabled: `True`
- Schedule: `every` `{'kind': 'every', 'everyMs': 28800000, 'anchorMs': 1770932011695}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 19. Daily Upgrade Protocol
- ID: `f47d5170-112d-473c-9c4a-d51662688899`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '14 10 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/openclaw` (exists=True, exec=x, syntax=n/a)

### 20. Tonal Health Check
- ID: `58db9015-b3bd-4be8-83ff-45ec5377b735`
- Enabled: `True`
- Schedule: `every` `{'kind': 'every', 'everyMs': 14400000, 'anchorMs': 1770936710935}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/Developer/cortana-external/tonal_tokens.json` (exists=True, exec=-, syntax=n/a)

### 21. Twitter Auth Check
- ID: `7eaa6ed0-152b-42cf-b9c9-bb63eab0a5a0`
- Enabled: `True`
- Schedule: `every` `{'kind': 'every', 'everyMs': 28800000, 'anchorMs': 1770936710968}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/openclaw/skills/bird/SKILL.md` (exists=True, exec=-, syntax=n/a)

### 22. 🧠 Weekly Memory Consolidation
- ID: `d624fa00-a244-4fab-a7e6-f79853adfabe`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '24 3 * * 0', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (3):
  - ✅ `/Users/hd/openclaw/MEMORY.md` (exists=True, exec=-, syntax=n/a)
  - ✅ `/Users/hd/openclaw/memory/archive/2026` (exists=True, exec=x, syntax=n/a)
  - ✅ `/Users/hd/openclaw/memory/archive/2026/` (exists=True, exec=x, syntax=n/a)

### 23. 🔍 Daily System Health Summary
- ID: `e2d5451c-4fc3-455a-b7e0-4cbc6da7b745`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '12 21 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 24. 🧹 Cron Session Cleanup
- ID: `fb9ba4df-0008-48a1-b56e-45ce35bc0fee`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 2 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/.openclaw/agents/main/sessions` (exists=True, exec=x, syntax=n/a)

### 25. 🔮 Weekly Cortana Status
- ID: `060be4f9-190a-4942-9ded-b34a95e46088`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 18 * * 0', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 26. 🌙 Weekend Pre-Bedtime (9:30pm Fri/Sat)
- ID: `b45d6452-71ea-44ab-bd70-ed3d2c2f5f82`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '30 21 * * 5,6', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 27. 📈 CANSLIM Alert Scan (market sessions)
- ID: `9d2f7f92-b9e9-48bc-87b0-a5859bb83927`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '30 9,12,15 * * 1-5', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (2):
  - ✅ `/Users/hd/Developer/cortana-external/backtester` (exists=True, exec=x, syntax=n/a)
  - ✅ `/Users/hd/Developer/cortana-external/backtester/venv/bin/python` (exists=True, exec=x, syntax=n/a)

### 28. 🌐 SAE World State Builder
- ID: `de405e3b-a1b5-433b-90e5-0d473ccc376e`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 7,13,21 * * *'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/openclaw/sae/world-state-builder.md` (exists=True, exec=-, syntax=n/a)

### 29. 🧠 SAE Cross-Domain Reasoner
- ID: `dad2a631-8af3-4a8a-aef4-d3450f2f44e0`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '15 7,13,21 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/openclaw/tools/sae/cross-domain-snapshot.sh` (exists=True, exec=x, syntax=ok)

### 30. memory-consolidation
- ID: `f7414f95-7795-4e5f-81c6-034e9609cac6`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '12 3 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 31. 🔍 Proprioception: Cron & Tool Health
- ID: `e53514fe-737b-43a2-8422-f9e749551761`
- Enabled: `True`
- Schedule: `every` `{'kind': 'every', 'everyMs': 900000, 'anchorMs': 1771323577113}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (3):
  - ✅ `/Users/hd/.openclaw/cron/jobs.json` (exists=True, exec=-, syntax=n/a)
  - ✅ `/Users/hd/openclaw` (exists=True, exec=x, syntax=n/a)
  - ✅ `/Users/hd/openclaw/proprioception/run_health_checks.py` (exists=True, exec=x, syntax=n/a)

### 32. 📊 Proprioception: Budget & Self-Model
- ID: `d583b511-b145-4bfd-8f63-ad7bc34ff1a3`
- Enabled: `True`
- Schedule: `every` `{'kind': 'every', 'everyMs': 1800000, 'anchorMs': 1771323590473}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (2):
  - ✅ `/Users/hd/openclaw/skills/telegram-usage/handler.js` (exists=True, exec=-, syntax=n/a)
  - ✅ `/tmp/proprio_usage.json` (exists=True, exec=-, syntax=n/a)

### 33. 📈 Proprioception: Efficiency Analyzer
- ID: `62772130-a454-42f9-8526-38dfdaa3eb05`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '30 2 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/openclaw/tools/monitoring/proprioception-metrics.sh` (exists=True, exec=x, syntax=ok)

### 34. immune-scan
- ID: `becbf6fc-066d-48c8-b8f2-05b2489ef91e`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '11 * * * *', 'tz': 'America/New_York', 'staggerMs': 300000}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (2):
  - ✅ `/Users/hd/.openclaw/agents/main/sessions` (exists=True, exec=x, syntax=n/a)
  - ✅ `/Users/hd/Developer/cortana-external/tonal_tokens.json` (exists=True, exec=-, syntax=n/a)

### 35. 🎯 Mission Advancement (Nightly)
- ID: `71c60384-58f3-4142-9ed4-092ec879d991`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 22 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (2):
  - ✅ `/Users/hd/openclaw/MEMORY.md` (exists=True, exec=-, syntax=n/a)
  - ✅ `/Users/hd/openclaw/SOUL.md` (exists=True, exec=-, syntax=n/a)

### 36. 📊 Weekly Monday Market Brief
- ID: `6f73e040-f468-4238-93d8-a0ab6e0cad3f`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 21 * * 0', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 37. 🐦 Bird Healthcheck (daily 7 AM ET)
- ID: `2024d6c1-899b-430a-9075-0556b086e9d5`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 7 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/openclaw/tools/market-intel/bird-healthcheck.sh` (exists=True, exec=x, syntax=ok)

### 38. Earnings checker + calendar sync (daily)
- ID: `eac7a31d-3c17-4d60-95a7-04cbb49ed71e`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 7 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/openclaw/tools/earnings/create-calendar-events.sh` (exists=True, exec=x, syntax=ok)

### 39. Earnings T-minus alert (held positions)
- ID: `92e4ae89-d486-4718-bb2f-9de86320e56e`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 13 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 40. 📚 Weekly Doc Gardener
- ID: `8f3c8b8a-3c2a-4f5e-bf30-6e0a9a1b9c42`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 20 * * 0', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths: none detected

### 41. Meta-monitor health rotation
- ID: `d1a8b3f4-8f8f-4cfe-ab20-b25077fe5578`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 */6 * * *', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/openclaw/tools/meta-monitor/meta-monitor.sh` (exists=True, exec=x, syntax=ok)

### 42. Earnings calendar weekday alert
- ID: `a7b2c3d4-e5f6-4a1b-8c9d-0e1f2a3b4c5d`
- Enabled: `True`
- Schedule: `cron` `{'kind': 'cron', 'expr': '0 8 * * 1-5', 'tz': 'America/New_York'}`
- Schedule validation: ✅ OK (ok)
- Referenced local paths (1):
  - ✅ `/Users/hd/openclaw/tools/earnings-alert/earnings-alert.sh` (exists=True, exec=x, syntax=ok)

## Findings
**Issues found: 1**
- ❌ Symlink invalid: /Users/hd/.openclaw/cron/jobs.json is not a symlink; expected /Users/hd/openclaw/config/cron/jobs.json