ALTER TABLE thread_outbox DROP CONSTRAINT thread_outbox_action_check;
ALTER TABLE thread_outbox ADD CONSTRAINT thread_outbox_action_check
    CHECK (action IN ('open', 'message', 'withdraw', 'stop', 'resume', 'settings'));
