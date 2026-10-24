ALTER TABLE thread_outbox
    ADD COLUMN completed_at timestamptz,
    ADD COLUMN completion jsonb;
