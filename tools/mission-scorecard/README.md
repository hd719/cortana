# Daily Mission Scorecard v1 (Task #373 slice)

Builds a Telegram-ready, <180-word daily scorecard with:
- top 1 Time action
- top 1 Health action
- top 1 Wealth action
- top 1 Career action
- one MIT (Most Important Task)

Each line includes estimated minutes.

## Usage

```bash
npx tsx tools/mission-scorecard/daily-mission-scorecard.ts
npx tsx tools/mission-scorecard/daily-mission-scorecard.ts --json
npx tsx tools/mission-scorecard/daily-mission-scorecard.ts --validate
```

## Data sources (current slice)

- `cortana_tasks` (`ready` + `in_progress`) for action candidates
- `cortana_sitrep_latest` (`calendar`, `health`, `finance`) for fallback context

## Validation path

`--validate` enforces:
- output <= 180 words
- all required sections present (Time/Health/Wealth/Career/MIT)
- minutes formatting present
