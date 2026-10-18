-- 中止请求与停止事实分开保存；持久命令由节点在心跳及补发输入前领取。
CREATE TABLE execution_stops (
    execution_id uuid PRIMARY KEY REFERENCES executions(id),
    reason text NOT NULL CHECK (reason IN ('cancelled', 'queue_timeout', 'execution_timeout')),
    requested_at timestamptz NOT NULL,
    acknowledged_at timestamptz,
    stopped_at timestamptz,
    outcome_known boolean NOT NULL DEFAULT false,
    not_started boolean NOT NULL DEFAULT false
);

ALTER TABLE tasks ADD COLUMN execution_expires_at timestamptz;
UPDATE tasks t SET execution_expires_at = e.started_at + t.execution_timeout_seconds * interval '1 second'
FROM executions e WHERE e.task_id = t.id AND e.started_at IS NOT NULL;
ALTER TABLE task_events ADD COLUMN occurred_at timestamptz;
ALTER TABLE task_events ADD COLUMN agent_stopped boolean;
ALTER TABLE task_events ADD COLUMN worker_sequence bigint NOT NULL DEFAULT 0 CHECK (worker_sequence >= 0);
ALTER TABLE task_events ADD COLUMN outcome_known boolean;
ALTER TABLE task_events ADD COLUMN not_started boolean;
ALTER TABLE task_events ADD COLUMN stop_reason text CHECK (stop_reason IN ('cancelled', 'queue_timeout', 'execution_timeout'));
ALTER TABLE task_events DROP CONSTRAINT task_events_kind_name;
ALTER TABLE task_events ADD CONSTRAINT task_events_kind_name CHECK (
    kind IN ('accepted', 'prepared', 'failed', 'start_authorized', 'needs_verification',
             'cancelled', 'started', 'result', 'cancel_requested', 'stop_requested', 'stop_report')
);
ALTER TABLE tasks DROP CONSTRAINT tasks_error_code;
ALTER TABLE tasks ADD CONSTRAINT tasks_error_code CHECK (
    error_code IS NULL OR error_code IN (
        'session_busy', 'unsupported', 'invalid_target', 'queue_timeout', 'unavailable', 'revoked',
        'result_format', 'execution_failed', 'uncertain_input', 'uncertain_worker', 'uncertain_history',
        'execution_timeout'
    )
);
ALTER TABLE task_events DROP CONSTRAINT task_events_reason_code;
ALTER TABLE task_events ADD CONSTRAINT task_events_reason_code CHECK (
    reason_code IS NULL OR reason_code IN (
        'session_busy', 'unsupported', 'invalid_target', 'queue_timeout', 'unavailable', 'revoked',
        'result_format', 'execution_failed', 'uncertain_input', 'uncertain_worker', 'uncertain_history',
        'execution_timeout'
    )
);
