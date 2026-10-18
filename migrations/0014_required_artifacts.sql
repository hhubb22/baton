ALTER TABLE tasks ADD COLUMN required_artifacts jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(required_artifacts) = 'array' AND jsonb_array_length(required_artifacts) <= 32);

ALTER TABLE tasks DROP CONSTRAINT tasks_error_code;
ALTER TABLE tasks ADD CONSTRAINT tasks_error_code CHECK (
    error_code IS NULL OR error_code IN (
        'session_busy', 'unsupported', 'invalid_target', 'queue_timeout', 'unavailable', 'revoked',
        'result_format', 'execution_failed', 'uncertain_input', 'uncertain_worker', 'uncertain_history',
        'execution_timeout', 'artifact_unavailable'
    )
);

ALTER TABLE task_events DROP CONSTRAINT task_events_reason_code;
ALTER TABLE task_events ADD CONSTRAINT task_events_reason_code CHECK (
    reason_code IS NULL OR reason_code IN (
        'session_busy', 'unsupported', 'invalid_target', 'queue_timeout', 'unavailable', 'revoked',
        'result_format', 'execution_failed', 'uncertain_input', 'uncertain_worker', 'uncertain_history',
        'execution_timeout', 'artifact_unavailable'
    )
);
