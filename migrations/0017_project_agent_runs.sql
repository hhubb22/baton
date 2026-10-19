CREATE TABLE agent_runs (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    node_id uuid NOT NULL,
    lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
    state text NOT NULL CHECK (state IN ('starting','running','finished','lost','failed')),
    provider text NOT NULL,
    model text NOT NULL,
    placement_reason text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    end_reason text,
    UNIQUE (agent_id, lease_epoch),
    FOREIGN KEY (employee_id, agent_id) REFERENCES project_agents(employee_id, id),
    FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id)
);
CREATE INDEX agent_runs_starting ON agent_runs(state) WHERE state='starting';
ALTER TABLE tasks ADD COLUMN project_id uuid,
    ADD COLUMN origin_conversation_id uuid,
    ADD COLUMN origin_tool_call_id text,
    ADD FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id),
    ADD FOREIGN KEY (employee_id, origin_conversation_id) REFERENCES conversations(employee_id, id),
    ADD CHECK ((origin_conversation_id IS NULL) = (origin_tool_call_id IS NULL));
CREATE UNIQUE INDEX tasks_origin_tool_call ON tasks(origin_conversation_id, origin_tool_call_id)
    WHERE origin_conversation_id IS NOT NULL;

-- 各来源在写入时限长，领取时不需要截断已经接受的输入。
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_input_source_size CHECK (
    (source_type <> 'task_result' OR octet_length(payload::text) <= 40960)
    AND (source_type <> 'memory_updated' OR octet_length(payload::text) <= 1024)
    AND (source_type <> 'project_updated' OR octet_length(payload::text) <= 4096)
    AND (source_type <> 'attention_answer' OR octet_length(payload::text) <= 8192)
);
ALTER TABLE agent_runs ADD COLUMN stop_acked_at timestamptz;
