# Council + Trading Alerts Integration

## Overview

`tools/council/trading-council.ts` wraps the plain-text output from:

- `canslim_alert.py`
- `dipbuyer_alert.py`

It parses candidate lines (`BUY`, `WATCH`, `NO_BUY`) and only runs Council deliberation for `BUY` signals.

Flow per BUY signal:

1. Create a deliberation session with `council-deliberate.ts`
   - title: `BUY signal: <TICKER> via <CANSLIM|DipBuyer>`
   - participants: `risk-analyst,momentum-analyst,fundamentals-analyst`
   - expires: 5 minutes
   - context: ticker, score, entry, stop, reason/source
2. Run 3 lightweight voter prompts (risk, momentum, fundamentals) with model `openai-codex/gpt-5.1`
3. Cast votes via `council.ts vote`
4. Tally final outcome via `council-tally.ts`
5. Append verdict summary to original alert output

`WATCH` and `NO_BUY` skip Council to reduce token spend.

## Token Cost Estimate

Per BUY signal (target budget):

- 3 voter prompts: ~200-500 input tokens each, ~100-200 output each
- 1 synthesis/tally note: ~500 input, ~200 output

Estimated total: **~$0.02-$0.05 per BUY signal** (model/provider dependent).

## Wiring Into Existing Alert Jobs

Pipe alert output into the wrapper before sending Telegram output.

### CANSLIM

```bash
python3 ~/Developer/cortana-external/backtester/canslim_alert.py \
  | npx tsx ~/Developer/cortana/tools/council/trading-council.ts
```

### Dip Buyer

```bash
python3 ~/Developer/cortana-external/backtester/dipbuyer_alert.py \
  | npx tsx ~/Developer/cortana/tools/council/trading-council.ts
```

## Example Cron Payload Modification

If your cron payload currently runs CANSLIM directly, update command/payload to include the wrapper pipeline.

Before:

```json
{
  "id": "9d2f7f92-b9e9-48bc-87b0-a5859bb83927",
  "command": "python3 ~/Developer/cortana-external/backtester/canslim_alert.py"
}
```

After:

```json
{
  "id": "9d2f7f92-b9e9-48bc-87b0-a5859bb83927",
  "command": "python3 ~/Developer/cortana-external/backtester/canslim_alert.py | npx tsx ~/Developer/cortana/tools/council/trading-council.ts"
}
```

Apply the same pattern for Dip Buyer jobs.
