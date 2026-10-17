-- 短时启动许可与取消竞态。许可签发事实和明确的未启动证据分开保存。
ALTER TABLE executions
    ADD COLUMN start_permit_expires_at timestamptz,
    ADD COLUMN permit_nonce text,
    ADD COLUMN start_refused_at timestamptz,
    ADD CONSTRAINT executions_permit_window CHECK (
        start_permit_expires_at IS NULL OR start_authorized_at IS NOT NULL
    ),
    ADD CONSTRAINT executions_permit_nonce_text CHECK (
        permit_nonce IS NULL OR (
            char_length(permit_nonce) BETWEEN 1 AND 80
            AND permit_nonce !~ '[[:cntrl:]]'
        )
    ),
    ADD CONSTRAINT executions_refused_after_authorized CHECK (
        start_refused_at IS NULL OR start_authorized_at IS NOT NULL
    );

ALTER TABLE tasks
    ADD COLUMN cancel_requested_at timestamptz;

ALTER TABLE tasks DROP CONSTRAINT tasks_error_code;
ALTER TABLE tasks
    ADD CONSTRAINT tasks_error_code CHECK (
        error_code IS NULL
        OR error_code IN (
            'session_busy', 'unsupported', 'invalid_target', 'queue_timeout', 'unavailable', 'revoked'
        )
    );

ALTER TABLE task_events DROP CONSTRAINT task_events_kind_name;
ALTER TABLE task_events
    ADD CONSTRAINT task_events_kind_name CHECK (
        kind IN (
            'accepted', 'prepared', 'failed',
            'start_authorized', 'needs_verification', 'cancelled'
        )
    );

ALTER TABLE task_events DROP CONSTRAINT task_events_reason_code;
ALTER TABLE task_events
    ADD CONSTRAINT task_events_reason_code CHECK (
        reason_code IS NULL
        OR reason_code IN (
            'session_busy', 'unsupported', 'invalid_target', 'queue_timeout', 'unavailable', 'revoked'
        )
    );
