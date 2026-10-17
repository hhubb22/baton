-- 待核实原因用稳定原因码保存。展示文案由中心根据原因码生成，不信任节点上报的句子。
-- task_events.execution_id 用来识别同一事件是否属于这次执行。

ALTER TABLE task_events
    ADD COLUMN execution_id uuid;

ALTER TABLE tasks DROP CONSTRAINT tasks_error_code;
ALTER TABLE tasks
    ADD CONSTRAINT tasks_error_code CHECK (
        error_code IS NULL
        OR error_code IN (
            'session_busy', 'unsupported', 'invalid_target', 'queue_timeout',
            'unavailable', 'revoked', 'result_format', 'execution_failed',
            'uncertain_input', 'uncertain_worker', 'uncertain_history'
        )
    );

ALTER TABLE task_events DROP CONSTRAINT task_events_reason_code;
ALTER TABLE task_events
    ADD CONSTRAINT task_events_reason_code CHECK (
        reason_code IS NULL
        OR reason_code IN (
            'session_busy', 'unsupported', 'invalid_target', 'queue_timeout',
            'unavailable', 'revoked', 'result_format', 'execution_failed',
            'uncertain_input', 'uncertain_worker', 'uncertain_history'
        )
    );
