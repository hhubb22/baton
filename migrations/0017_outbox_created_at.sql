ALTER TABLE thread_outbox ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
