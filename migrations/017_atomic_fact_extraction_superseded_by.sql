-- Task 131 follow-up: superseded_by + fact_type support

ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS fact_type TEXT,
  ADD COLUMN IF NOT EXISTS superseded_by BIGINT,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cortana_memory_semantic_superseded_by_fkey'
  ) THEN
    ALTER TABLE cortana_memory_semantic
      ADD CONSTRAINT cortana_memory_semantic_superseded_by_fkey
      FOREIGN KEY (superseded_by) REFERENCES cortana_memory_semantic(id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cortana_memory_semantic_fact_type_check'
  ) THEN
    ALTER TABLE cortana_memory_semantic DROP CONSTRAINT cortana_memory_semantic_fact_type_check;
  END IF;

  ALTER TABLE cortana_memory_semantic
    ALTER COLUMN fact_type SET DEFAULT 'fact';

  UPDATE cortana_memory_semantic
  SET fact_type = 'fact'
  WHERE fact_type IS NULL;

  ALTER TABLE cortana_memory_semantic
    ADD CONSTRAINT cortana_memory_semantic_fact_type_check
    CHECK (fact_type = ANY (ARRAY['fact','preference','event','system_rule','decision','rule','relationship']));
END $$;

CREATE INDEX IF NOT EXISTS idx_memory_semantic_superseded_by
  ON cortana_memory_semantic(superseded_by);
