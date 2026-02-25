BEGIN;

ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS superseded_by BIGINT;

ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS access_count INT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cortana_memory_semantic'
      AND column_name = 'supersedes_memory_id'
  ) THEN
    UPDATE cortana_memory_semantic
    SET supersedes_id = supersedes_memory_id
    WHERE supersedes_id IS NULL
      AND supersedes_memory_id IS NOT NULL;
  END IF;
END $$;

UPDATE cortana_memory_semantic older
SET superseded_by = newer.id,
    superseded_at = COALESCE(older.superseded_at, NOW())
FROM cortana_memory_semantic newer
WHERE newer.supersedes_id = older.id
  AND (older.superseded_by IS NULL OR older.superseded_by != newer.id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cortana_memory_semantic_superseded_by_fkey'
      AND conrelid = 'cortana_memory_semantic'::regclass
  ) THEN
    ALTER TABLE cortana_memory_semantic
      ADD CONSTRAINT cortana_memory_semantic_superseded_by_fkey
      FOREIGN KEY (superseded_by) REFERENCES cortana_memory_semantic(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_memory_semantic_active_not_superseded
  ON cortana_memory_semantic(active, superseded_by);

CREATE INDEX IF NOT EXISTS idx_memory_semantic_superseded_by
  ON cortana_memory_semantic(superseded_by);

COMMIT;
