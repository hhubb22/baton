CREATE TABLE threads (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees(id),
    client_thread_id text NOT NULL CHECK (octet_length(client_thread_id) BETWEEN 1 AND 256),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
    project_id uuid,
    origin_conversation_id uuid,
    origin_tool_call_id text,
    node_id uuid NOT NULL,
    agent_type text NOT NULL,
    working_directory text NOT NULL,
    execution_timeout_seconds integer NOT NULL DEFAULT 7200 CHECK (execution_timeout_seconds>0),
    status text NOT NULL DEFAULT 'waiting_device' CHECK (status IN ('waiting_device','running','idle','stopped','unknown','archived')),
    status_reason text NOT NULL DEFAULT '',
    created_by text NOT NULL CHECK (created_by IN ('employee','project_agent')),
    storage_generation text,
    native_session_id text,
    opened_at timestamptz,
    archived_at timestamptz,
    archive_requested_at timestamptz,
    stop_requested_at timestamptz,
    stop_confirmed_at timestamptz,
    last_reported_at timestamptz,
    last_worker_seq bigint NOT NULL DEFAULT 0 CHECK (last_worker_seq>=0),
    version bigint NOT NULL DEFAULT 1 CHECK (version>0),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_activity_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (employee_id,id),
    UNIQUE (employee_id,client_thread_id),
    UNIQUE (origin_conversation_id,origin_tool_call_id),
    UNIQUE (employee_id,id,node_id),
    FOREIGN KEY (employee_id,node_id) REFERENCES nodes(employee_id,id),
    FOREIGN KEY (employee_id,project_id) REFERENCES projects(employee_id,id),
    FOREIGN KEY (employee_id,origin_conversation_id) REFERENCES conversations(employee_id,id),
    CHECK ((origin_conversation_id IS NULL)=(origin_tool_call_id IS NULL)),
    CHECK (created_by<>'project_agent' OR (project_id IS NOT NULL AND origin_conversation_id IS NOT NULL))
);
CREATE INDEX threads_activity ON threads(employee_id,last_activity_at DESC,id DESC);
CREATE INDEX threads_project ON threads(employee_id,project_id,last_activity_at DESC,id DESC);

CREATE TABLE thread_turns (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    worker_turn_seq bigint NOT NULL CHECK (worker_turn_seq>0),
    initiator text NOT NULL CHECK (initiator IN ('employee','project_agent')),
    origin_tool_call_id text,
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    end_reason text,
    UNIQUE (employee_id,thread_id,id),
    UNIQUE (employee_id,thread_id,id,worker_turn_seq),
    UNIQUE (employee_id,thread_id,worker_turn_seq),
    FOREIGN KEY (employee_id,thread_id) REFERENCES threads(employee_id,id),
    CHECK ((ended_at IS NULL)=(end_reason IS NULL))
);
CREATE UNIQUE INDEX thread_one_active_turn ON thread_turns(thread_id) WHERE ended_at IS NULL;
CREATE TABLE thread_messages (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    client_message_id text NOT NULL CHECK (octet_length(client_message_id) BETWEEN 1 AND 256),
    sender text NOT NULL CHECK (sender IN ('employee','project_agent')),
    origin_tool_call_id text,
    content text NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 65536),
    mode text NOT NULL DEFAULT 'queue' CHECK (mode IN ('queue','steer')),
    status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','queued','sent','withdrawn','unknown')),
    turn_id uuid,
    worker_turn_seq bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (thread_id,client_message_id),
    UNIQUE (employee_id,thread_id,id),
    FOREIGN KEY (employee_id,thread_id) REFERENCES threads(employee_id,id),
    FOREIGN KEY (employee_id,thread_id,turn_id,worker_turn_seq) REFERENCES thread_turns(employee_id,thread_id,id,worker_turn_seq),
    CHECK ((turn_id IS NULL)=(worker_turn_seq IS NULL))
);
CREATE TABLE thread_replies (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    worker_seq bigint NOT NULL CHECK (worker_seq>0),
    turn_id uuid NOT NULL,
    worker_turn_seq bigint NOT NULL,
    content text NOT NULL CHECK (octet_length(content)<=32768),
    truncated boolean NOT NULL DEFAULT false,
    original_bytes bigint NOT NULL CHECK (original_bytes>=octet_length(content)),
    attachments jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attachments)='array' AND octet_length(attachments::text)<=4096),
    metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=4096),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (thread_id,worker_seq),
    FOREIGN KEY (employee_id,thread_id) REFERENCES threads(employee_id,id),
    FOREIGN KEY (employee_id,thread_id,turn_id,worker_turn_seq) REFERENCES thread_turns(employee_id,thread_id,id,worker_turn_seq)
);
CREATE TABLE thread_events (
    id bigserial PRIMARY KEY,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    kind text NOT NULL,
    actor text NOT NULL,
    actor_id text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (employee_id,thread_id) REFERENCES threads(employee_id,id)
);
CREATE INDEX thread_events_timeline ON thread_events(employee_id,thread_id,id);
CREATE TRIGGER thread_events_append_only BEFORE UPDATE OR DELETE ON thread_events
    FOR EACH ROW EXECUTE FUNCTION reject_project_history_mutation();
CREATE TABLE thread_outbox (
    id bigserial PRIMARY KEY,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    node_id uuid NOT NULL,
    message_id uuid NOT NULL UNIQUE,
    action text NOT NULL CHECK (action IN ('open','message','withdraw','stop')),
    payload jsonb NOT NULL DEFAULT '{}',
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    acked_at timestamptz,
    result jsonb,
    FOREIGN KEY (employee_id,thread_id,node_id) REFERENCES threads(employee_id,id,node_id)
);
CREATE INDEX thread_outbox_node_due ON thread_outbox(node_id,next_attempt_at,id) WHERE acked_at IS NULL;
CREATE INDEX thread_outbox_order ON thread_outbox(thread_id,id) WHERE acked_at IS NULL;
CREATE TABLE thread_reports (
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    event_id uuid NOT NULL,
    worker_seq bigint NOT NULL CHECK (worker_seq>0),
    payload_hash bytea NOT NULL CHECK (octet_length(payload_hash)=32),
    ack jsonb NOT NULL,
    PRIMARY KEY (thread_id,event_id),
    UNIQUE (thread_id,worker_seq),
    FOREIGN KEY (employee_id,thread_id) REFERENCES threads(employee_id,id)
);
ALTER TABLE project_agent_input_queue DROP CONSTRAINT project_agent_input_queue_source_type_check;
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_agent_input_queue_source_type_check
    CHECK (source_type IN ('user_message','task_result','user_task_result','attention_answer','memory_updated','project_updated','thread_reply','turn_ended'));
