# Mission Control Deploy Script

## Path
`tools/mission-control/deploy.ts`

## What it does
1. `cd /Users/hd/Developer/cortana-external`
2. `git pull origin main`
3. `cd apps/mission-control`
4. `pnpm install --frozen-lockfile`
5. `pnpm build`
6. `launchctl kickstart -k gui/$(id -u)/com.cortana.mission-control`
7. Logs success/failure to `tools/mission-control/logs/deploy.log`

## Usage
```bash
npx tsx tools/mission-control/deploy.ts
```

## Notes
- Uses `/opt/homebrew/bin/pnpm` explicitly.
- Exits immediately on first failure (`set -euo pipefail`).
- Intended for manual deploys now, and can be called from a git post-push hook later.

## Post-deploy verification

After deploy:

1. `curl http://127.0.0.1:3000/api/heartbeat-status`
2. `curl http://127.0.0.1:3001/api/heartbeat-status` if the dev profile is running
3. open `http://127.0.0.1:3000/trading-ops` for prod or `http://127.0.0.1:3001/trading-ops` for dev
4. run the Trading Ops smoke check from `cortana-external/apps/mission-control`:

```bash
cd /Users/hd/Developer/cortana-external/apps/mission-control
pnpm exec tsx scripts/check-trading-ops-smoke.ts
```

Mission Control environment map:
- prod: port `3000`, launchd label `com.cortana.mission-control`, `MARKET_LAB_ENV=prod`
- dev: port `3001`, launchd label `com.cortana.mission-control-dev`, `MARKET_LAB_ENV=dev`
- `3002` is intentionally unused.
