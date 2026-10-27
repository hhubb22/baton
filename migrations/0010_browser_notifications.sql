CREATE TABLE browser_notification_cursors (
    employee_id uuid PRIMARY KEY REFERENCES employees(id),
    last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0)
);

CREATE TABLE browser_notifications (
    employee_id uuid NOT NULL REFERENCES employees(id),
    seq bigint CHECK (seq > 0),
    event_id uuid PRIMARY KEY,
    source_key text NOT NULL,
    event jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    published_at timestamptz,
    UNIQUE (employee_id, seq),
    UNIQUE (employee_id, source_key),
    CHECK (seq IS NOT NULL OR published_at IS NULL)
);

CREATE INDEX browser_notifications_pending ON browser_notifications (employee_id, seq)
    WHERE published_at IS NULL AND seq IS NOT NULL;

CREATE INDEX browser_notification_intents ON browser_notifications (employee_id, created_at, event_id)
    WHERE seq IS NULL;
