# Migration Hygiene Policy

## Problem
`migrations/` contains historical duplicate numeric prefixes (`012`, `013`, `016`, `017`, `019`). Renaming those files now is unsafe because some environments may already have applied them by filename.

## Chosen mechanism (safe, no historical rewrites)
We **do not rename existing migrations**.

Instead we enforce deterministic ordering and future uniqueness with:
1. `migrations/manifest.json` as the canonical execution order for all existing files.
2. `tools/covenant/migration_hygiene.py` to validate:
   - every `.sql` migration is represented in the manifest
   - every manifest entry exists on disk
   - filename format `NNN_slug.sql`
   - duplicate prefixes are only allowed if explicitly grandfathered in `legacy_duplicate_prefixes`
3. Future migration rule: next migration prefix must be unique and monotonic (`max + 1`).

## How to add a new migration
1. Get the next legal prefix:
   ```bash
   python3 tools/covenant/migration_hygiene.py --next-prefix
   ```
2. Create file using `NNN_description.sql`.
3. Append it to `migrations/manifest.json` `order` list.
4. Run check:
   ```bash
   python3 tools/covenant/migration_hygiene.py
   ```

## Why this approach
- Avoids breaking already-applied migrations.
- Gives deterministic ordering now.
- Prevents new collisions going forward.
