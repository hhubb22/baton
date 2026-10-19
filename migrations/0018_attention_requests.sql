CREATE TABLE attention_requests (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    origin_tool_call_id text,
    source text NOT NULL CHECK (source IN ('agent','system')),
    condition_type text,
    condition_object_id uuid,
    task_id uuid,
    task_result_version integer,
    task_result jsonb,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 280),
    content text NOT NULL DEFAULT '' CHECK (octet_length(content) <= 32768),
    options jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(options)='array' AND jsonb_array_length(options)<=5),
    allow_text boolean NOT NULL DEFAULT false,
    action_url text NOT NULL DEFAULT '',
    state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','answered','closed','withdrawn','resolved')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    resolution jsonb,
    resolved_at timestamptz,
    withdraw_reason text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id,id),
    FOREIGN KEY (employee_id, agent_id) REFERENCES project_agents(employee_id,id),
    FOREIGN KEY (employee_id, conversation_id) REFERENCES conversations(employee_id,id),
    FOREIGN KEY (employee_id, task_id) REFERENCES tasks(employee_id,id),
    UNIQUE (conversation_id, origin_tool_call_id),
    CHECK ((task_id IS NULL AND task_result_version IS NULL AND task_result IS NULL)
        OR (task_id IS NOT NULL AND task_result_version IS NOT NULL AND task_result_version > 0 AND task_result IS NOT NULL)),
    CHECK ((source='agent' AND origin_tool_call_id IS NOT NULL AND condition_type IS NULL AND condition_object_id IS NULL AND state<>'resolved')
        OR (source='system' AND origin_tool_call_id IS NULL AND condition_type IS NOT NULL AND condition_type IN ('project_needs_attention','task_needs_verification')
            AND condition_object_id IS NOT NULL AND NOT allow_text AND options='[]' AND state<>'answered')),
    CHECK (source<>'system'
        OR (condition_type='project_needs_attention' AND condition_object_id=project_id AND task_id IS NULL)
        OR (condition_type='task_needs_verification' AND task_id IS NOT NULL AND condition_object_id=task_id))
);
CREATE UNIQUE INDEX attention_system_open ON attention_requests(condition_type,condition_object_id) WHERE source='system' AND state='open';
CREATE INDEX attention_inbox ON attention_requests(employee_id,created_at DESC,id DESC);
CREATE INDEX attention_project ON attention_requests(project_id,state);

-- 4 KiB 回复经 JSON 转义后仍须完整保存。
ALTER TABLE project_agent_input_queue DROP CONSTRAINT project_input_source_size;
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_input_source_size CHECK (
    (source_type <> 'task_result' OR octet_length(payload::text) <= 40960)
    AND (source_type <> 'memory_updated' OR octet_length(payload::text) <= 1024)
    AND (source_type <> 'project_updated' OR octet_length(payload::text) <= 4096)
    AND (source_type <> 'attention_answer' OR octet_length(payload::text) <= 32768)
);
