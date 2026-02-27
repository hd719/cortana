-- 001-freeze-status-enum.sql
-- Freeze cortana_tasks.status to canonical lifecycle values only.

-- First verify no non-canonical values exist
SELECT DISTINCT status
FROM cortana_tasks
WHERE status NOT IN ('backlog', 'ready', 'scheduled', 'in_progress', 'completed', 'failed', 'cancelled');

-- Normalize legacy aliases if present before constraining
UPDATE cortana_tasks SET status = 'ready' WHERE status = 'pending';
UPDATE cortana_tasks SET status = 'completed' WHERE status = 'done';
UPDATE cortana_tasks SET status = 'ready' WHERE status = 'blocked';

-- Replace any prior status check with canonical-only constraint
ALTER TABLE cortana_tasks DROP CONSTRAINT IF EXISTS cortana_tasks_status_check;

-- Add CHECK constraint
ALTER TABLE cortana_tasks
  ADD CONSTRAINT cortana_tasks_status_check
  CHECK (status IN ('backlog', 'ready', 'scheduled', 'in_progress', 'completed', 'failed', 'cancelled'));
