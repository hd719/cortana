#!/usr/bin/env npx tsx
import { spawnSync } from "child_process";

const script = String.raw`set -euo pipefail

# create-calendar-events.sh
# Creates Clawdbot-Calendar events for earnings within 48h.
# Idempotent: skips if event title already exists on target date.
# Reminders: T-60m and T-10m only.

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check-earnings.sh"
CAL_NAME="Clawdbot-Calendar"

GOG_HELPER="$SCRIPT_DIR/../gog/gog-with-env.ts"

if ! command -v gog >/dev/null 2>&1; then
  echo "gog CLI not found" >&2
  exit 1
fi

json_input=""
if [[ -t 0 ]]; then
  json_input="$($CHECK_SCRIPT)"
else
  json_input="$(cat)"
fi

[[ -z "$json_input" ]] && exit 0

existing="$(npx tsx "$GOG_HELPER" cal list "$CAL_NAME" --from today --plain 2>/dev/null || true)"

jq -c '.[] | select(.earnings_date != null and .days_until != null and .days_until >= 0 and .days_until <= 2)' <<<"$json_input" \
| while IFS= read -r row; do
    symbol="$(jq -r '.symbol' <<<"$row")"
    earnings_date="$(jq -r '.earnings_date' <<<"$row")"
    title="\${symbol} Earnings"
    when_local="\${earnings_date} 16:00"

    # Idempotency check: same title + date found in calendar listing.
    if echo "$existing" | grep -F "$title" | grep -F "$earnings_date" >/dev/null 2>&1; then
      continue
    fi

    npx tsx "$GOG_HELPER" cal add "$CAL_NAME" \
      --title "$title" \
      --when "$when_local" \
      --duration 60m \
      --reminder 60 \
      --reminder 10 >/dev/null

    echo "created: $title @ $when_local"
  done
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const r = spawnSync("bash", ["-lc", script, "script", ...args], { encoding: "utf8" });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}

main();
