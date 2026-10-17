-- 执行输入、结构化结果和交付确认。完整会话历史不进入这些表。

ALTER TABLE executions
    ADD COLUMN started_at timestamptz,
    ADD COLUMN input_generation integer,
    ADD CONSTRAINT executions_input_generation_positive CHECK (
        input_generation IS NULL OR input_generation >= 1
    ),
    ADD CONSTRAINT executions_started_after_authorized CHECK (
        started_at IS NULL OR start_authorized_at IS NOT NULL
    );

ALTER TABLE tasks
    ADD COLUMN summary text,
    ADD COLUMN evidence_empty_reason text,
    ADD COLUMN artifacts_empty_reason text,
    ADD CONSTRAINT tasks_summary_text CHECK (
        summary IS NULL OR (
            char_length(summary) BETWEEN 1 AND 4000
            AND summary !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]'
        )
    ),
    ADD CONSTRAINT tasks_evidence_empty_reason_text CHECK (
        evidence_empty_reason IS NULL OR (
            char_length(evidence_empty_reason) BETWEEN 1 AND 400
            AND evidence_empty_reason !~ '[[:cntrl:]]'
        )
    ),
    ADD CONSTRAINT tasks_artifacts_empty_reason_text CHECK (
        artifacts_empty_reason IS NULL OR (
            char_length(artifacts_empty_reason) BETWEEN 1 AND 400
            AND artifacts_empty_reason !~ '[[:cntrl:]]'
        )
    );

ALTER TABLE tasks DROP CONSTRAINT tasks_error_code;
ALTER TABLE tasks
    ADD CONSTRAINT tasks_error_code CHECK (
        error_code IS NULL
        OR error_code IN (
            'session_busy', 'unsupported', 'invalid_target', 'queue_timeout',
            'unavailable', 'revoked', 'result_format', 'execution_failed'
        )
    );

ALTER TABLE task_events DROP CONSTRAINT task_events_kind_name;
ALTER TABLE task_events
    ADD CONSTRAINT task_events_kind_name CHECK (
        kind IN (
            'accepted', 'prepared', 'failed',
            'start_authorized', 'needs_verification', 'cancelled',
            'started', 'result'
        )
    );

ALTER TABLE task_events DROP CONSTRAINT task_events_reason_code;
ALTER TABLE task_events
    ADD CONSTRAINT task_events_reason_code CHECK (
        reason_code IS NULL
        OR reason_code IN (
            'session_busy', 'unsupported', 'invalid_target', 'queue_timeout',
            'unavailable', 'revoked', 'result_format', 'execution_failed'
        )
    );

CREATE TABLE task_result_refs (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    task_id uuid NOT NULL,
    execution_id uuid NOT NULL REFERENCES executions (id),
    kind text NOT NULL,
    position integer NOT NULL,
    node_id uuid,
    storage_ref text,
    resource_id text NOT NULL,
    access_status text NOT NULL,
    note text,
    CONSTRAINT task_result_refs_task_fk
        FOREIGN KEY (employee_id, task_id) REFERENCES tasks (employee_id, id),
    CONSTRAINT task_result_refs_kind CHECK (kind IN ('evidence', 'artifact')),
    CONSTRAINT task_result_refs_position CHECK (position >= 0 AND position < 32),
    CONSTRAINT task_result_refs_slot UNIQUE (task_id, kind, position),
    CONSTRAINT task_result_refs_access CHECK (
        access_status IN ('available', 'unavailable', 'unknown')
    ),
    CONSTRAINT task_result_refs_location CHECK (
        node_id IS NOT NULL OR storage_ref IS NOT NULL
    ),
    CONSTRAINT task_result_refs_resource CHECK (
        char_length(resource_id) BETWEEN 1 AND 200
        AND resource_id !~ '[[:cntrl:]]'
    ),
    CONSTRAINT task_result_refs_storage_text CHECK (
        storage_ref IS NULL OR (
            char_length(storage_ref) BETWEEN 1 AND 1024
            AND storage_ref !~ '[[:cntrl:]]'
        )
    ),
    CONSTRAINT task_result_refs_note_text CHECK (
        note IS NULL OR (
            char_length(note) BETWEEN 1 AND 400
            AND note !~ '[[:cntrl:]]'
        )
    )
);

CREATE TABLE delivery_records (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees (id),
    task_id uuid NOT NULL,
    execution_id uuid NOT NULL REFERENCES executions (id),
    source_session_id uuid,
    status text NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT delivery_records_execution_event UNIQUE (execution_id, id),
    CONSTRAINT delivery_records_task_fk
        FOREIGN KEY (employee_id, task_id) REFERENCES tasks (employee_id, id),
    CONSTRAINT delivery_records_source_fk
        FOREIGN KEY (employee_id, source_session_id) REFERENCES sessions (employee_id, id),
    CONSTRAINT delivery_records_status_name CHECK (status = 'delivered')
);
