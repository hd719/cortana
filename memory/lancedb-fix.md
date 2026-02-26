# LanceDB Extension Fix (OpenClaw)

**Date:** 2026-02-25  
**Issue:** `memory-lancedb: failed to load LanceDB. Error: Cannot find module '@lancedb/lancedb'`

## What I checked

1. Extension directory exists and contains expected files:
   - Path: `/opt/homebrew/lib/node_modules/openclaw/extensions/memory-lancedb/`
   - Includes: `index.ts`, `package.json`, `openclaw.plugin.json`, etc.

2. LanceDB package scope was missing in OpenClaw root `node_modules`:
   - Checked path: `/opt/homebrew/lib/node_modules/openclaw/node_modules/@lancedb/`
   - Result: directory did not exist.

## Fix applied

Installed missing dependency in OpenClaw install root:

```bash
cd /opt/homebrew/lib/node_modules/openclaw
npm install @lancedb/lancedb
```

Install succeeded.

## Verification

Confirmed module now resolves from OpenClaw directory:

```bash
node -e "require('@lancedb/lancedb'); console.log('ok')"
```

Output: `ok`

## Notes

- Because install succeeded, no extension repair/reinstall command investigation was needed.
- `npm` reported unrelated existing vulnerabilities during install (`8 high severity`) but this did not block the LanceDB fix.
