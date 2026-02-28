# Mission Control Deploy Script

## Path
`~/openclaw/tools/mission-control/deploy.sh`

## What it does
1. `cd /Users/hd/Developer/cortana-external`
2. `git pull origin main`
3. `cd apps/mission-control`
4. `pnpm install --frozen-lockfile`
5. `pnpm build`
6. `launchctl kickstart -k gui/$(id -u)/com.cortana.mission-control`
7. Logs success/failure to `~/openclaw/tools/mission-control/logs/deploy.log`

## Usage
```bash
~/openclaw/tools/mission-control/deploy.sh
```

## Notes
- Uses `/opt/homebrew/bin/pnpm` explicitly.
- Exits immediately on first failure (`set -euo pipefail`).
- Intended for manual deploys now, and can be called from a git post-push hook later.
