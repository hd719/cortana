-- Extend event bus allowed event types for sub-agent lifecycle signals.

BEGIN;

ALTER TABLE cortana_event_bus_events
    DROP CONSTRAINT IF EXISTS cortana_event_bus_events_event_type_check;

ALTER TABLE cortana_event_bus_events
    ADD CONSTRAINT cortana_event_bus_events_event_type_check
    CHECK (
        event_type IN (
            'email_received',
            'task_created',
            'calendar_approaching',
            'portfolio_alert',
            'health_update',
            'artifact_created',
            'artifact_consumed',
            'agent_spawned',
            'agent_completed',
            'agent_failed',
            'agent_timeout'
        )
    );

COMMIT;
