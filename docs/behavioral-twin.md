# Behavioral Twin: Predictive Chief-State Model (Timing + Tone)

## What this does
`tools/behavioral-twin/predict` infers current Chief state and messaging guidance from `cortana_patterns`.

It returns JSON:

```json
{
  "state": "awake|busy|available|winding-down|sleeping",
  "confidence": 0.0,
  "recommended_tone": "energetic|brief|balanced|minimal",
  "alert_ok": true,
  "next_available_window": "ISO_START/ISO_END"
}
```

## Data source
The model queries:
- `cortana_patterns.pattern_type = 'wake'`
- `cortana_patterns.pattern_type = 'sleep_check'`

And extracts:
- day-of-week wake/sleep medians from `value` (`HH:MM`)
- hour-of-day activity density from record timestamps

If data is sparse, it falls back to priors:
- wake ≈ `04:40`
- sleep ≈ `22:00`

## State logic (high-level)
- **sleeping**: before wake window or well after sleep window
- **awake**: first ~90 min after wake
- **winding-down**: ~90 min before sleep
- **busy/available**: daytime classification (weekday core hours bias to busy)

Confidence is scaled by sample volume.

## Tone calibration
- Morning (4:00-7:59): `energetic`
- Late night (22:00-4:59): `minimal`
- Post-workout/morning transition (6:00-8:59): `brief`
- Busy: `brief`
- Winding-down: `minimal`
- Otherwise: `balanced`

## Alert gating
`--urgency` values: `low|normal|high|urgent|critical`

- available/awake: alert OK
- busy/winding-down: alert only if `urgent`/`high`/`critical`
- sleeping: alert only if `critical`

## CLI usage
```bash
# Default (now, normal urgency)
~/openclaw/tools/behavioral-twin/predict

# Urgent decision right now
~/openclaw/tools/behavioral-twin/predict --urgency urgent

# Predict at a specific time
~/openclaw/tools/behavioral-twin/predict --at "2026-02-25T23:15:00-05:00"

# Increase historical window for trend smoothing
~/openclaw/tools/behavioral-twin/predict --days-back 120
```

## Example output
```json
{"state":"busy","confidence":0.61,"recommended_tone":"brief","alert_ok":false,"next_available_window":"2026-02-25T12:00:00-05:00/2026-02-25T13:00:00-05:00"}
```
