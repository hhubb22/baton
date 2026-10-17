CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees (id),
    node_id uuid NOT NULL,
    agent_type text NOT NULL,
    parent_session_id uuid,
    native_session_id text,
    status text NOT NULL,
    bound_execution_id uuid,
    storage_generation text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT sessions_employee_session_unique UNIQUE (employee_id, id),
    CONSTRAINT sessions_node_fk
        FOREIGN KEY (employee_id, node_id) REFERENCES nodes (employee_id, id),
    CONSTRAINT sessions_parent_fk
        FOREIGN KEY (employee_id, parent_session_id) REFERENCES sessions (employee_id, id),
    CONSTRAINT sessions_execution_fk
        FOREIGN KEY (bound_execution_id) REFERENCES executions (id),
    CONSTRAINT sessions_parent_not_self CHECK (parent_session_id IS NULL OR parent_session_id <> id),
    CONSTRAINT sessions_agent_type_shape CHECK (agent_type ~ '^[a-z][a-z0-9._-]{0,63}$'),
    CONSTRAINT sessions_status_name CHECK (
        status IN ('idle', 'running', 'waiting_input', 'stopped', 'unknown')
    ),
    CONSTRAINT sessions_native_id_text CHECK (
        native_session_id IS NULL
        OR (
            char_length(native_session_id) BETWEEN 1 AND 200
            AND native_session_id !~ '[[:cntrl:]]'
        )
    ),
    CONSTRAINT sessions_storage_generation_text CHECK (
        storage_generation IS NULL
        OR (
            char_length(storage_generation) BETWEEN 1 AND 80
            AND storage_generation !~ '[[:cntrl:]]'
        )
    )
);

CREATE INDEX sessions_employee_updated ON sessions (employee_id, updated_at DESC, id DESC);

ALTER TABLE tasks
    ADD CONSTRAINT tasks_source_session_fk
        FOREIGN KEY (employee_id, source_session_id) REFERENCES sessions (employee_id, id),
    ADD CONSTRAINT tasks_target_session_fk
        FOREIGN KEY (employee_id, target_session_id) REFERENCES sessions (employee_id, id),
    ADD COLUMN error_code text,
    ADD COLUMN error_message text,
    ADD CONSTRAINT tasks_error_code CHECK (
        error_code IS NULL
        OR error_code IN ('session_busy', 'unsupported', 'invalid_target', 'queue_timeout', 'unavailable')
    ),
    ADD CONSTRAINT tasks_error_message CHECK (
        error_message IS NULL
        OR (
            char_length(error_message) BETWEEN 1 AND 400
            AND error_message !~ '[[:cntrl:]]'
        )
    );

CREATE TABLE task_relations (
    employee_id uuid NOT NULL,
    task_id uuid NOT NULL,
    source_task_id uuid,
    source_session_id uuid,
    target_session_id uuid,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT task_relations_pk PRIMARY KEY (employee_id, task_id),
    CONSTRAINT task_relations_task_fk
        FOREIGN KEY (employee_id, task_id) REFERENCES tasks (employee_id, id),
    CONSTRAINT task_relations_source_task_fk
        FOREIGN KEY (employee_id, source_task_id) REFERENCES tasks (employee_id, id),
    CONSTRAINT task_relations_source_session_fk
        FOREIGN KEY (employee_id, source_session_id) REFERENCES sessions (employee_id, id),
    CONSTRAINT task_relations_target_session_fk
        FOREIGN KEY (employee_id, target_session_id) REFERENCES sessions (employee_id, id)
);

ALTER TABLE task_events DROP CONSTRAINT task_events_kind_name;
ALTER TABLE task_events
    ADD CONSTRAINT task_events_kind_name CHECK (kind IN ('accepted', 'prepared', 'failed')),
    ADD COLUMN reason_code text,
    ADD CONSTRAINT task_events_reason_code CHECK (
        reason_code IS NULL
        OR reason_code IN ('session_busy', 'unsupported', 'invalid_target', 'queue_timeout', 'unavailable')
    );

ALTER TABLE dispatch_outbox
    ADD COLUMN acked_at timestamptz,
    ADD COLUMN attempts integer NOT NULL DEFAULT 0,
    ADD CONSTRAINT dispatch_outbox_attempts_nonnegative CHECK (attempts >= 0);

CREATE INDEX dispatch_outbox_due
    ON dispatch_outbox (created_at, id)
    WHERE acked_at IS NULL;
