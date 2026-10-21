-- 员工验收单独保存，不改变执行结论或生成新的执行。
CREATE TABLE task_acceptances (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    task_id uuid NOT NULL,
    task_version integer NOT NULL CHECK (task_version > 0),
    decision text NOT NULL CHECK (decision IN ('passed', 'rejected')),
    comment text NOT NULL CHECK (char_length(comment) BETWEEN 1 AND 400),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (employee_id, task_id) REFERENCES tasks (employee_id, id),
    UNIQUE (task_id, task_version)
);

ALTER TABLE project_agent_input_queue DROP CONSTRAINT project_agent_input_queue_source_type_check;
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_agent_input_queue_source_type_check
    CHECK (source_type IN ('user_message', 'task_result', 'user_task_result', 'attention_answer', 'memory_updated', 'project_updated'));
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_user_task_result_size
    CHECK (source_type <> 'user_task_result' OR octet_length(payload::text) <= 40960);

ALTER TABLE tasks ADD COLUMN user_operation jsonb;
ALTER TABLE tasks ADD CONSTRAINT tasks_user_operation_check CHECK (
    user_operation IS NULL OR (jsonb_typeof(user_operation) = 'object' AND octet_length(user_operation::text) <= 1024)
);
