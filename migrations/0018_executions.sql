CREATE TABLE executions (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees(id),
    project_id uuid NOT NULL REFERENCES projects(id),
    node_id uuid NOT NULL REFERENCES nodes(id),
    origin_conversation_id uuid NOT NULL REFERENCES conversations(id),
    origin_tool_call_id text NOT NULL,
    request_hash bytea NOT NULL,
    command text NOT NULL,
    working_directory text NOT NULL,
    timeout_seconds integer NOT NULL CHECK (timeout_seconds > 0),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled','timed_out','unknown')),
    storage_generation text NOT NULL,
    last_report_seq bigint NOT NULL DEFAULT 0,
    version bigint NOT NULL DEFAULT 1,
    exit_code integer,
    reason text,
    output text,
    encoding text CHECK (encoding = 'base64'),
    total_bytes bigint,
    truncated boolean,
    full_output jsonb,
    stop_requested_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    wait_until timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (employee_id,origin_conversation_id,origin_tool_call_id)
);
CREATE INDEX executions_project ON executions(employee_id,project_id,id);
CREATE TABLE execution_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    message_id uuid NOT NULL UNIQUE,
    action text NOT NULL CHECK (action IN ('start','stop')),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    acked_at timestamptz,
    result jsonb,
    UNIQUE (execution_id,action)
);
CREATE TABLE execution_reports (
    execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    event_id uuid NOT NULL,
    seq bigint NOT NULL,
    payload_hash bytea NOT NULL,
    ack jsonb NOT NULL,
    PRIMARY KEY (execution_id,event_id),
    UNIQUE (execution_id,seq)
);
ALTER TABLE project_agent_input_queue DROP CONSTRAINT project_agent_input_queue_source_type_check;
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_agent_input_queue_source_type_check
    CHECK (source_type IN ('user_message','memory_updated','project_updated','thread_reply','turn_ended','thread_message_failed','execution.finished'));
ALTER TABLE project_agent_input_queue DROP CONSTRAINT project_input_source_size;
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_input_source_size CHECK (
    (source_type NOT IN ('thread_reply','thread_message_failed') OR octet_length(payload::text) <= 40960)
    AND (source_type <> 'turn_ended' OR octet_length(payload::text) <= 4096)
    AND (source_type <> 'execution.finished' OR octet_length(payload::text) <= 73728)
    AND (source_type <> 'memory_updated' OR octet_length(payload::text) <= 1024)
    AND (source_type <> 'project_updated' OR octet_length(payload::text) <= 4096)
);
