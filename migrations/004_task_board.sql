-- Task Board Migration: Epic/Task/Subtask Hierarchy with Dependencies
-- File: 004_task_board.sql
-- Created: 2026-02-19

BEGIN;

-- Create cortana_epics table
CREATE TABLE IF NOT EXISTS cortana_epics (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
    deadline TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
);

-- Add new columns to cortana_tasks (if they don't exist)
DO $$ 
BEGIN
    -- Add epic_id column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'cortana_tasks' AND column_name = 'epic_id'
    ) THEN
        ALTER TABLE cortana_tasks ADD COLUMN epic_id INTEGER REFERENCES cortana_epics(id);
    END IF;

    -- Add parent_id column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'cortana_tasks' AND column_name = 'parent_id'
    ) THEN
        ALTER TABLE cortana_tasks ADD COLUMN parent_id INTEGER REFERENCES cortana_tasks(id);
    END IF;

    -- Add assigned_to column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'cortana_tasks' AND column_name = 'assigned_to'
    ) THEN
        ALTER TABLE cortana_tasks ADD COLUMN assigned_to TEXT;
    END IF;
END $$;

-- Update existing status values to match new schema
UPDATE cortana_tasks SET status = 'done' WHERE status = 'completed';
UPDATE cortana_tasks SET status = 'done' WHERE status = 'surfaced';

-- Drop existing status constraint if it exists
ALTER TABLE cortana_tasks DROP CONSTRAINT IF EXISTS cortana_tasks_status_check;

-- Add updated status constraint
ALTER TABLE cortana_tasks ADD CONSTRAINT cortana_tasks_status_check 
    CHECK (status IN ('pending', 'blocked', 'in_progress', 'done', 'cancelled'));

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_cortana_tasks_epic_id ON cortana_tasks(epic_id);
CREATE INDEX IF NOT EXISTS idx_cortana_tasks_parent_id ON cortana_tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_cortana_tasks_status ON cortana_tasks(status);
CREATE INDEX IF NOT EXISTS idx_cortana_tasks_auto_executable ON cortana_tasks(auto_executable);
CREATE INDEX IF NOT EXISTS idx_cortana_epics_status ON cortana_epics(status);

COMMIT;