ALTER TABLE project_agent_input_queue DROP CONSTRAINT project_agent_input_queue_source_type_check;
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_agent_input_queue_source_type_check
    CHECK (source_type IN ('user_message', 'task_result', 'user_task_result', 'attention_answer', 'memory_updated', 'project_updated'));
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_user_task_result_size
    CHECK (source_type <> 'user_task_result' OR octet_length(payload::text) <= 40960);

ALTER TABLE tasks ADD COLUMN user_operation jsonb;
ALTER TABLE tasks ADD CONSTRAINT tasks_user_operation_check CHECK (
    user_operation IS NULL OR (jsonb_typeof(user_operation) = 'object' AND octet_length(user_operation::text) <= 1024)
);
