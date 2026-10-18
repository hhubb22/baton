CREATE TABLE plane_issues (
    webhook_id uuid NOT NULL,
    project_id uuid NOT NULL,
    issue_id uuid NOT NULL,
    linked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (webhook_id, project_id, issue_id)
);

CREATE TABLE plane_triggers (
    trigger_id text PRIMARY KEY,
    webhook_id uuid NOT NULL,
    project_id uuid NOT NULL,
    issue_id uuid NOT NULL,
    round_at timestamptz NOT NULL,
    state_activity_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    employee_id uuid REFERENCES employees (id),
    task_input jsonb,
    task_id uuid REFERENCES tasks (id),
    block_code text NOT NULL DEFAULT '',
    block_fields text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (webhook_id, project_id, issue_id, state_activity_id),
    FOREIGN KEY (webhook_id, project_id, issue_id)
        REFERENCES plane_issues (webhook_id, project_id, issue_id)
);

CREATE TABLE plane_deliveries (
    webhook_id uuid NOT NULL,
    project_id uuid NOT NULL,
    delivery_id uuid NOT NULL,
    body_hash bytea NOT NULL CHECK (octet_length(body_hash) = 32),
    issue_id uuid NOT NULL,
    trigger_id text REFERENCES plane_triggers (trigger_id),
    event_input jsonb NOT NULL,
    outcome text NOT NULL DEFAULT 'pending',
    block_code text NOT NULL DEFAULT '',
    block_fields text[] NOT NULL DEFAULT '{}',
    received_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now() + interval '5 seconds',
    last_error_code text NOT NULL DEFAULT '',
    processed_at timestamptz,
    PRIMARY KEY (webhook_id, project_id, delivery_id),
    UNIQUE (webhook_id, project_id, body_hash),
    FOREIGN KEY (webhook_id, project_id, issue_id)
        REFERENCES plane_issues (webhook_id, project_id, issue_id)
);

CREATE INDEX plane_deliveries_pending ON plane_deliveries (webhook_id, project_id, next_attempt_at)
    WHERE processed_at IS NULL;
