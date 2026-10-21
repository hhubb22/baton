ALTER TABLE threads ADD COLUMN exec_wait_until timestamptz;

ALTER TABLE thread_replies DROP CONSTRAINT thread_replies_content_check;
ALTER TABLE thread_replies DROP CONSTRAINT thread_replies_check;
ALTER TABLE thread_replies ADD CONSTRAINT thread_replies_content_check CHECK (
    CASE WHEN metadata->>'encoding'='base64' THEN octet_length(content)<=45056
         ELSE octet_length(content)<=32768 END
);
ALTER TABLE thread_replies ADD CONSTRAINT thread_replies_check CHECK (
    CASE WHEN metadata->>'encoding'='base64' THEN original_bytes>=0
         ELSE original_bytes>=octet_length(content) END
);

-- 历史事项移除任务快照，旧任务系统事项保留处理记录。
UPDATE attention_requests SET state='withdrawn', version=version+1,
    withdraw_reason='任务事项已停止维护', resolved_at=clock_timestamp(), updated_at=clock_timestamp()
    WHERE source='system' AND condition_type='task_needs_verification' AND state='open';
ALTER TABLE attention_requests DROP CONSTRAINT attention_requests_check;
ALTER TABLE attention_requests DROP CONSTRAINT attention_requests_check1;
ALTER TABLE attention_requests DROP CONSTRAINT attention_requests_check2;
UPDATE attention_requests SET task_id=NULL,task_result_version=NULL,task_result=NULL;
UPDATE attention_requests SET condition_type='project_needs_attention',condition_object_id=project_id,
    action_url='/projects/' || project_id::text WHERE source='system';
ALTER TABLE attention_requests ADD COLUMN thread_id uuid;
ALTER TABLE attention_requests ADD FOREIGN KEY (employee_id,thread_id) REFERENCES threads(employee_id,id);
ALTER TABLE attention_requests ADD CONSTRAINT attention_source CHECK (
    (source='agent' AND origin_tool_call_id IS NOT NULL AND condition_type IS NULL
        AND condition_object_id IS NULL AND state<>'resolved')
    OR (source='system' AND origin_tool_call_id IS NULL AND condition_type IS NOT NULL
        AND condition_type='project_needs_attention' AND condition_object_id IS NOT NULL
        AND condition_object_id=project_id AND thread_id IS NULL AND NOT allow_text
        AND options='[]' AND state<>'answered')
);
ALTER TABLE attention_requests ADD CONSTRAINT attention_no_task_snapshot CHECK (
    task_id IS NULL AND task_result_version IS NULL AND task_result IS NULL
);
DROP INDEX attention_system_open;
CREATE UNIQUE INDEX attention_system_open ON attention_requests(project_id) WHERE source='system' AND state='open';
CREATE INDEX attention_thread ON attention_requests(thread_id) WHERE thread_id IS NOT NULL;

ALTER TABLE project_agent_input_queue DROP CONSTRAINT project_input_source_size;
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_input_source_size CHECK (
    (source_type <> 'task_result' OR octet_length(payload::text) <=
        CASE WHEN payload ? 'command_result' THEN 73728 ELSE 40960 END)
    AND (source_type <> 'thread_reply' OR octet_length(payload::text) <= 40960)
    AND (source_type <> 'turn_ended' OR octet_length(payload::text) <=
        CASE WHEN payload ? 'command_result' THEN 73728 ELSE 4096 END)
    AND (source_type <> 'memory_updated' OR octet_length(payload::text) <= 1024)
    AND (source_type <> 'project_updated' OR octet_length(payload::text) <= 4096)
    AND (source_type <> 'attention_answer' OR octet_length(payload::text) <= 32768)
);
