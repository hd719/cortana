-- cortana_tasks state integrity migration
-- Purpose: enforce safe status transitions and done/completed_at consistency.

BEGIN;

-- 1) Hard invariant: done tasks must have completed_at.
ALTER TABLE cortana_tasks
  DROP CONSTRAINT IF EXISTS cortana_tasks_done_requires_completed_at;

ALTER TABLE cortana_tasks
  ADD CONSTRAINT cortana_tasks_done_requires_completed_at
  CHECK (status <> 'done' OR completed_at IS NOT NULL);

-- 2) Trigger function for transition guard + autofill.
CREATE OR REPLACE FUNCTION cortana_tasks_state_integrity_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Auto-set completed_at when transitioning to done without explicit value.
  IF NEW.status = 'done' AND NEW.completed_at IS NULL THEN
    NEW.completed_at := NOW();
  END IF;

  -- Reject impossible transition done -> pending unless explicitly reopened.
  -- Explicit reopen flag is metadata.explicit_reopen=true.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'done'
     AND NEW.status = 'pending'
     AND COALESCE((NEW.metadata ->> 'explicit_reopen')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'Invalid transition for cortana_tasks.id=%s: done -> pending requires metadata.explicit_reopen=true',
        COALESCE(NEW.id, OLD.id)
      ),
      ERRCODE = '23514';
  END IF;

  -- If explicitly reopened to pending, clear completed_at.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'done'
     AND NEW.status = 'pending'
     AND COALESCE((NEW.metadata ->> 'explicit_reopen')::boolean, false) IS TRUE THEN
    NEW.completed_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cortana_tasks_state_integrity_tg ON cortana_tasks;

CREATE TRIGGER cortana_tasks_state_integrity_tg
BEFORE INSERT OR UPDATE OF status, completed_at, metadata
ON cortana_tasks
FOR EACH ROW
EXECUTE FUNCTION cortana_tasks_state_integrity_guard();

COMMIT;
