ALTER TABLE tasks ADD COLUMN exec_wait_until timestamptz;
ALTER TABLE tasks ADD COLUMN command_result jsonb;

ALTER TABLE project_agent_input_queue DROP CONSTRAINT project_input_source_size;
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_input_source_size CHECK (
    (source_type <> 'task_result' OR octet_length(payload::text) <=
        CASE WHEN payload ? 'command_result' THEN 73728 ELSE 40960 END)
    AND (source_type <> 'memory_updated' OR octet_length(payload::text) <= 1024)
    AND (source_type <> 'project_updated' OR octet_length(payload::text) <= 4096)
    AND (source_type <> 'attention_answer' OR octet_length(payload::text) <= 32768)
);

ALTER TABLE project_agent_input_queue DROP CONSTRAINT project_user_task_result_size;
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_user_task_result_size CHECK (
    source_type <> 'user_task_result' OR octet_length(payload::text) <=
        CASE WHEN payload ? 'command_result' THEN 73728 ELSE 40960 END
);
