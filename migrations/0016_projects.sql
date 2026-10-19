CREATE TABLE projects (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees(id),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND title !~ '[[:cntrl:]]'),
    goal text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (employee_id, id)
);

CREATE TABLE project_agents (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL UNIQUE,
    provider text NOT NULL DEFAULT '',
    model text NOT NULL DEFAULT '',
    prompt_version text NOT NULL DEFAULT '1',
    lease_run_id uuid,
    lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
    lease_until timestamptz,
    UNIQUE (employee_id, id),
    FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id),
    CHECK ((lease_run_id IS NULL) = (lease_until IS NULL))
);

CREATE TABLE conversations (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    kind text NOT NULL DEFAULT 'primary' CHECK (kind = 'primary'),
    next_seq bigint NOT NULL DEFAULT 1 CHECK (next_seq > 0),
    compaction_seq bigint,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'needs_attention')),
    attention_reason text,
    failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    next_attempt_at timestamptz,
    UNIQUE (employee_id, id),
    UNIQUE (agent_id, kind),
    FOREIGN KEY (employee_id, agent_id) REFERENCES project_agents(employee_id, id),
    CHECK (compaction_seq > 0 AND compaction_seq < next_seq)
);

CREATE TABLE conversation_events (
    conversation_id uuid NOT NULL,
    seq bigint NOT NULL CHECK (seq > 0),
    employee_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('input', 'assistant', 'tool_result', 'compaction')),
    client_event_id text,
    tool_call_id text,
    run_id uuid,
    lease_epoch bigint CHECK (lease_epoch >= 0),
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 163840),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, seq),
    UNIQUE (conversation_id, client_event_id),
    UNIQUE (employee_id, conversation_id, seq),
    FOREIGN KEY (employee_id, conversation_id) REFERENCES conversations(employee_id, id),
    CHECK (kind <> 'tool_result' OR tool_call_id IS NOT NULL)
);
CREATE UNIQUE INDEX conversation_tool_result_once
    ON conversation_events(conversation_id, tool_call_id) WHERE kind = 'tool_result';

CREATE TABLE project_agent_input_queue (
    id bigserial PRIMARY KEY,
    employee_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    source_type text NOT NULL CHECK (source_type IN ('user_message', 'task_result', 'attention_answer', 'memory_updated', 'project_updated')),
    source_key text NOT NULL,
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 73728),
    payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
    delivered_seq bigint CHECK (delivered_seq > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_id, source_key),
    FOREIGN KEY (employee_id, agent_id) REFERENCES project_agents(employee_id, id)
);
CREATE INDEX project_agent_pending_inputs ON project_agent_input_queue(agent_id, id)
    WHERE delivered_seq IS NULL;

CREATE TABLE project_memory_entries (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND title !~ '[[:cntrl:]]'),
    current_revision bigint NOT NULL CHECK (current_revision > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (employee_id, id),
    FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id)
);

CREATE TABLE project_memory_revisions (
    entry_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    content text NOT NULL,
    author text NOT NULL CHECK (author IN ('agent', 'user')),
    source_seq bigint CHECK (source_seq > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entry_id, revision),
    FOREIGN KEY (employee_id, entry_id) REFERENCES project_memory_entries(employee_id, id)
);
ALTER TABLE project_memory_entries ADD CONSTRAINT project_memory_current_revision_fk
    FOREIGN KEY (id, current_revision) REFERENCES project_memory_revisions(entry_id, revision)
    DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX project_memory_project ON project_memory_entries(employee_id, project_id, id);

CREATE FUNCTION reject_project_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '对话事件和记忆修订只允许追加' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER conversation_events_append_only BEFORE UPDATE OR DELETE ON conversation_events
    FOR EACH ROW EXECUTE FUNCTION reject_project_history_mutation();
CREATE TRIGGER project_memory_revisions_append_only BEFORE UPDATE OR DELETE ON project_memory_revisions
    FOR EACH ROW EXECUTE FUNCTION reject_project_history_mutation();
