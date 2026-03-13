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
