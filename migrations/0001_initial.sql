-- 扩展是数据库级对象，固定装在 public；连接的 search_path 包含 public。
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE FUNCTION reject_project_history_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION '对话事件和记忆修订只允许追加' USING ERRCODE = '23514';
END;
$$;

CREATE SEQUENCE node_registration_seq;

CREATE SEQUENCE thread_activity_check_seq;

-- 员工与网页登录

CREATE TABLE employees (
    id uuid NOT NULL,
    username text NOT NULL,
    display_name text NOT NULL,
    auth_source text NOT NULL,
    external_subject text,
    password_hash text,
    must_change_password boolean NOT NULL,
    password_changed_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT employees_auth_source_shape CHECK (auth_source ~ '^[a-z][a-z0-9._-]{0,62}$'::text),
    CONSTRAINT employees_display_name_text CHECK ((char_length(display_name) >= 1) AND (char_length(display_name) <= 80) AND (display_name !~ '[[:cntrl:]]'::text)),
    CONSTRAINT employees_secret_shape CHECK (((auth_source = 'local'::text) AND (password_hash ~~ '$argon2id$%'::text) AND (external_subject IS NULL)) OR ((auth_source <> 'local'::text) AND (password_hash IS NULL) AND (external_subject IS NOT NULL))),
    CONSTRAINT employees_username_shape CHECK (username ~ '^[a-z][a-z0-9._-]{0,62}$'::text),
    CONSTRAINT employees_pkey PRIMARY KEY (id),
    CONSTRAINT employees_username_unique UNIQUE (username)
);
CREATE UNIQUE INDEX employees_external_subject_unique ON employees USING btree (auth_source, external_subject) WHERE (external_subject IS NOT NULL);

CREATE TABLE employee_settings (
    employee_id uuid NOT NULL,
    default_device_node_id uuid,
    updated_at timestamptz NOT NULL,
    CONSTRAINT employee_settings_pkey PRIMARY KEY (employee_id),
    CONSTRAINT employee_settings_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id)
);

CREATE TABLE login_sessions (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    csrf_hash bytea NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT login_sessions_hash_length CHECK ((octet_length(token_hash) = 32) AND (octet_length(csrf_hash) = 32)),
    CONSTRAINT login_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT login_sessions_token_hash_unique UNIQUE (token_hash),
    CONSTRAINT login_sessions_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id)
);
CREATE INDEX login_sessions_employee_id ON login_sessions USING btree (employee_id);

-- 设备与设备码登录

CREATE TABLE nodes (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    display_name text NOT NULL,
    system_name text NOT NULL,
    capabilities text[] NOT NULL,
    registration_seq bigint NOT NULL,
    registered_at timestamptz NOT NULL,
    credential_version integer NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT nodes_capabilities_count CHECK (cardinality(capabilities) <= 32),
    CONSTRAINT nodes_credential_version_positive CHECK (credential_version >= 1),
    CONSTRAINT nodes_display_name_text CHECK ((char_length(display_name) >= 1) AND (char_length(display_name) <= 80) AND (display_name !~ '[[:cntrl:]]'::text)),
    CONSTRAINT nodes_registration_seq_positive CHECK (registration_seq > 0),
    CONSTRAINT nodes_system_name CHECK (system_name IN ('windows', 'macos', 'linux')),
    CONSTRAINT nodes_employee_node_unique UNIQUE (employee_id, id),
    CONSTRAINT nodes_pkey PRIMARY KEY (id),
    CONSTRAINT nodes_registration_seq_unique UNIQUE (registration_seq),
    CONSTRAINT nodes_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id)
);
CREATE INDEX nodes_employee_seq ON nodes USING btree (employee_id, registration_seq) WHERE (revoked_at IS NULL);

CREATE TABLE node_credentials (
    id uuid NOT NULL,
    node_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    version integer NOT NULL,
    created_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT node_credentials_version_positive CHECK (version >= 1),
    CONSTRAINT node_credentials_node_version_unique UNIQUE (node_id, version),
    CONSTRAINT node_credentials_pkey PRIMARY KEY (id),
    CONSTRAINT node_credentials_node_fk FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id)
);

CREATE TABLE node_presence (
    node_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    online boolean NOT NULL,
    synced boolean NOT NULL,
    incarnation text NOT NULL,
    conn_id text NOT NULL,
    last_contact_at timestamptz,
    status_updated_at timestamptz NOT NULL,
    CONSTRAINT node_presence_conn_len CHECK ((char_length(conn_id) >= 1) AND (char_length(conn_id) <= 80)),
    CONSTRAINT node_presence_incarnation_len CHECK ((char_length(incarnation) >= 1) AND (char_length(incarnation) <= 80)),
    CONSTRAINT node_presence_pkey PRIMARY KEY (node_id),
    CONSTRAINT node_presence_node_fk FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id),
    CONSTRAINT node_presence_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id)
);

CREATE TABLE node_revocations (
    id uuid NOT NULL,
    node_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    actor_employee_id uuid NOT NULL,
    credential_id uuid NOT NULL,
    requested_at timestamptz NOT NULL,
    applied_at timestamptz,
    CONSTRAINT node_revocations_applied_after CHECK ((applied_at IS NULL) OR (applied_at >= requested_at)),
    CONSTRAINT node_revocations_credential_unique UNIQUE (credential_id),
    CONSTRAINT node_revocations_pkey PRIMARY KEY (id),
    CONSTRAINT node_revocations_actor_employee_id_fkey FOREIGN KEY (actor_employee_id) REFERENCES employees(id),
    CONSTRAINT node_revocations_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES node_credentials(id),
    CONSTRAINT node_revocations_node_fk FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id)
);
CREATE INDEX node_revocations_node_id ON node_revocations USING btree (node_id);
CREATE INDEX node_revocations_pending ON node_revocations USING btree (requested_at) WHERE (applied_at IS NULL);

CREATE TABLE node_runtime_reports (
    node_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    report_version bigint NOT NULL,
    reported_at timestamptz NOT NULL,
    report jsonb NOT NULL,
    CONSTRAINT node_runtime_reports_size CHECK (octet_length((report)::text) <= 65536),
    CONSTRAINT node_runtime_reports_version_positive CHECK (report_version > 0),
    CONSTRAINT node_runtime_reports_pkey PRIMARY KEY (node_id),
    CONSTRAINT node_runtime_reports_node_fk FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id)
);

CREATE TABLE device_login_sessions (
    id uuid NOT NULL,
    device_code_hash bytea NOT NULL,
    user_code text NOT NULL,
    display_name text NOT NULL,
    system text NOT NULL,
    status text NOT NULL,
    employee_id uuid,
    node_id uuid,
    credential_id uuid,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    CONSTRAINT device_login_sessions_check CHECK (expires_at > created_at),
    CONSTRAINT device_login_sessions_check1 CHECK ((status <> ALL (ARRAY['approved'::text, 'consumed'::text])) OR ((employee_id IS NOT NULL) AND (node_id IS NOT NULL) AND (credential_id IS NOT NULL))),
    CONSTRAINT device_login_sessions_check2 CHECK ((status <> 'pending'::text) OR ((employee_id IS NULL) AND (node_id IS NULL) AND (credential_id IS NULL))),
    CONSTRAINT device_login_sessions_check3 CHECK ((status <> 'consumed'::text) OR (consumed_at IS NOT NULL)),
    CONSTRAINT device_login_sessions_device_code_hash_check CHECK (octet_length(device_code_hash) = 32),
    CONSTRAINT device_login_sessions_display_name_check CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 80)) AND (display_name !~ '[[:cntrl:]]'::text)),
    CONSTRAINT device_login_sessions_status_check CHECK (status IN ('pending', 'approved', 'consumed', 'denied', 'expired')),
    CONSTRAINT device_login_sessions_system_check CHECK (system IN ('macos', 'linux', 'windows')),
    CONSTRAINT device_login_sessions_user_code_check CHECK (user_code ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'::text),
    CONSTRAINT device_login_sessions_device_code_hash_key UNIQUE (device_code_hash),
    CONSTRAINT device_login_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT device_login_sessions_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES node_credentials(id),
    CONSTRAINT device_login_sessions_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT device_login_sessions_employee_id_node_id_fkey FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id)
);
CREATE UNIQUE INDEX device_login_pending_user_code ON device_login_sessions USING btree (user_code) WHERE (status = 'pending'::text);
CREATE INDEX device_login_user_code ON device_login_sessions USING btree (user_code, created_at DESC);

-- Project、Project Agent 与主对话

CREATE TABLE projects (
    memory_embedding jsonb,
    client_project_id uuid,
    create_request jsonb,
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    title text NOT NULL,
    goal text DEFAULT '' NOT NULL,
    status text DEFAULT 'active' NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    emoji text DEFAULT '📁' NOT NULL,
    CONSTRAINT projects_status_check CHECK (status IN ('active', 'paused', 'archived')),
    CONSTRAINT projects_title_check CHECK ((char_length(title) >= 1) AND (char_length(title) <= 200) AND (title !~ '[[:cntrl:]]'::text)),
    CONSTRAINT projects_version_check CHECK (version > 0),
    CONSTRAINT projects_employee_id_client_project_id_key UNIQUE (employee_id, client_project_id),
    CONSTRAINT projects_employee_id_id_key UNIQUE (employee_id, id),
    CONSTRAINT projects_pkey PRIMARY KEY (id),
    CONSTRAINT projects_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id)
);

CREATE TABLE project_agents (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    provider text DEFAULT '' NOT NULL,
    model text DEFAULT '' NOT NULL,
    prompt_version text DEFAULT '1' NOT NULL,
    lease_run_id uuid,
    lease_epoch bigint DEFAULT 0 NOT NULL,
    lease_until timestamptz,
    source_node_id uuid,
    CONSTRAINT project_agents_check CHECK ((lease_run_id IS NULL) = (lease_until IS NULL)),
    CONSTRAINT project_agents_lease_epoch_check CHECK (lease_epoch >= 0),
    CONSTRAINT project_agents_employee_id_id_key UNIQUE (employee_id, id),
    CONSTRAINT project_agents_pkey PRIMARY KEY (id),
    CONSTRAINT project_agents_project_id_key UNIQUE (project_id),
    CONSTRAINT project_agents_employee_id_project_id_fkey FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id),
    CONSTRAINT project_agents_source_node_id_fkey FOREIGN KEY (source_node_id) REFERENCES nodes(id)
);

CREATE TABLE agent_runs (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    node_id uuid NOT NULL,
    lease_epoch bigint NOT NULL,
    state text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    placement_reason text NOT NULL,
    memory_job_id uuid,
    memory_claim_until timestamptz,
    started_at timestamptz DEFAULT now() NOT NULL,
    ended_at timestamptz,
    end_reason text,
    stop_acked_at timestamptz,
    stop_requested_at timestamptz,
    command_next_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    command_attempts integer DEFAULT 0 NOT NULL,
    host_check_seq bigint DEFAULT 0 NOT NULL,
    CONSTRAINT agent_runs_command_attempts_check CHECK (command_attempts >= 0),
    CONSTRAINT agent_runs_host_check_seq_check CHECK (host_check_seq >= 0),
    CONSTRAINT agent_runs_lease_epoch_check CHECK (lease_epoch > 0),
    CONSTRAINT agent_runs_state_check CHECK (state IN ('starting', 'running', 'finished', 'lost', 'failed')),
    CONSTRAINT agent_runs_pkey PRIMARY KEY (id),
    CONSTRAINT agent_runs_employee_id_agent_id_fkey FOREIGN KEY (employee_id, agent_id) REFERENCES project_agents(employee_id, id),
    CONSTRAINT agent_runs_employee_id_node_id_fkey FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id)
);
CREATE UNIQUE INDEX agent_runs_agent_epoch ON agent_runs USING btree (agent_id, lease_epoch) WHERE (memory_job_id IS NULL);
CREATE UNIQUE INDEX agent_runs_memory_epoch ON agent_runs USING btree (memory_job_id, lease_epoch) WHERE (memory_job_id IS NOT NULL);
CREATE INDEX agent_runs_start_due ON agent_runs USING btree (node_id, command_next_at, id) WHERE ((state = 'starting'::text) AND (stop_requested_at IS NULL));
CREATE INDEX agent_runs_starting ON agent_runs USING btree (state) WHERE (state = 'starting'::text);
CREATE INDEX agent_runs_stop_due ON agent_runs USING btree (node_id, command_next_at, id) WHERE ((stop_requested_at IS NOT NULL) AND (stop_acked_at IS NULL));
CREATE INDEX agent_runs_wake_nodes ON agent_runs USING btree (node_id, id) WHERE ((state = 'running'::text) AND (stop_requested_at IS NULL));

CREATE TABLE conversations (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    kind text DEFAULT 'primary' NOT NULL,
    next_seq bigint DEFAULT 1 NOT NULL,
    compaction_seq bigint,
    state text DEFAULT 'active' NOT NULL,
    attention_reason text,
    failure_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamptz,
    read_reply_seq bigint DEFAULT 0 NOT NULL,
    CONSTRAINT conversations_check CHECK ((compaction_seq > 0) AND (compaction_seq < next_seq)),
    CONSTRAINT conversations_failure_count_check CHECK (failure_count >= 0),
    CONSTRAINT conversations_kind_check CHECK (kind = 'primary'::text),
    CONSTRAINT conversations_next_seq_check CHECK (next_seq > 0),
    CONSTRAINT conversations_read_reply_seq_check CHECK (read_reply_seq >= 0),
    CONSTRAINT conversations_state_check CHECK (state IN ('active', 'needs_attention')),
    CONSTRAINT conversations_agent_id_kind_key UNIQUE (agent_id, kind),
    CONSTRAINT conversations_employee_id_id_key UNIQUE (employee_id, id),
    CONSTRAINT conversations_pkey PRIMARY KEY (id),
    CONSTRAINT conversations_employee_id_agent_id_fkey FOREIGN KEY (employee_id, agent_id) REFERENCES project_agents(employee_id, id)
);

CREATE TABLE conversation_events (
    conversation_id uuid NOT NULL,
    seq bigint NOT NULL,
    employee_id uuid NOT NULL,
    kind text NOT NULL,
    client_event_id text,
    tool_call_id text,
    run_id uuid,
    lease_epoch bigint,
    payload jsonb NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT conversation_events_check CHECK ((kind <> 'tool_result'::text) OR (tool_call_id IS NOT NULL)),
    CONSTRAINT conversation_events_kind_check CHECK (kind IN ('input', 'assistant', 'tool_result', 'compaction')),
    CONSTRAINT conversation_events_lease_epoch_check CHECK (lease_epoch >= 0),
    CONSTRAINT conversation_events_payload_check CHECK (octet_length((payload)::text) <= 163840),
    CONSTRAINT conversation_events_seq_check CHECK (seq > 0),
    CONSTRAINT conversation_events_conversation_id_client_event_id_key UNIQUE (conversation_id, client_event_id),
    CONSTRAINT conversation_events_employee_id_conversation_id_seq_key UNIQUE (employee_id, conversation_id, seq),
    CONSTRAINT conversation_events_pkey PRIMARY KEY (conversation_id, seq),
    CONSTRAINT conversation_events_employee_id_conversation_id_fkey FOREIGN KEY (employee_id, conversation_id) REFERENCES conversations(employee_id, id)
);
CREATE UNIQUE INDEX conversation_tool_result_once ON conversation_events USING btree (conversation_id, tool_call_id) WHERE (kind = 'tool_result'::text);
CREATE TRIGGER conversation_events_append_only BEFORE DELETE OR UPDATE ON conversation_events FOR EACH ROW EXECUTE FUNCTION reject_project_history_mutation();

CREATE TABLE project_agent_input_queue (
    id bigserial,
    employee_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    source_type text NOT NULL,
    source_key text NOT NULL,
    payload jsonb NOT NULL,
    payload_hash bytea NOT NULL,
    delivered_seq bigint,
    created_at timestamptz DEFAULT now() NOT NULL,
    wake_required boolean DEFAULT false NOT NULL,
    wake_next_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    wake_attempts integer DEFAULT 0 NOT NULL,
    CONSTRAINT project_agent_input_queue_delivered_seq_check CHECK (delivered_seq > 0),
    CONSTRAINT project_agent_input_queue_payload_check CHECK (octet_length((payload)::text) <= 73728),
    CONSTRAINT project_agent_input_queue_payload_hash_check CHECK (octet_length(payload_hash) = 32),
    CONSTRAINT project_agent_input_queue_source_type_check CHECK (source_type IN ('user_message', 'memory_updated', 'project_updated', 'thread_reply', 'turn_ended', 'thread_message_failed', 'execution.finished')),
    CONSTRAINT project_agent_input_queue_wake_attempts_check CHECK (wake_attempts >= 0),
    CONSTRAINT project_input_source_size CHECK (((source_type <> ALL (ARRAY['thread_reply'::text, 'thread_message_failed'::text])) OR (octet_length((payload)::text) <= 40960)) AND ((source_type <> 'turn_ended'::text) OR (octet_length((payload)::text) <= 4096)) AND ((source_type <> 'execution.finished'::text) OR (octet_length((payload)::text) <= 73728)) AND ((source_type <> 'memory_updated'::text) OR (octet_length((payload)::text) <= 1024)) AND ((source_type <> 'project_updated'::text) OR (octet_length((payload)::text) <= 4096))),
    CONSTRAINT project_agent_input_queue_agent_id_source_key_key UNIQUE (agent_id, source_key),
    CONSTRAINT project_agent_input_queue_pkey PRIMARY KEY (id),
    CONSTRAINT project_agent_input_queue_employee_id_agent_id_fkey FOREIGN KEY (employee_id, agent_id) REFERENCES project_agents(employee_id, id)
);
CREATE INDEX project_agent_pending_inputs ON project_agent_input_queue USING btree (agent_id, id) WHERE (delivered_seq IS NULL);
CREATE INDEX project_inputs_wake_due ON project_agent_input_queue USING btree (agent_id, wake_next_at, id) WHERE ((delivered_seq IS NULL) AND wake_required);

-- Thread

CREATE TABLE threads (
    next_model text DEFAULT '' NOT NULL,
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    client_thread_id text NOT NULL,
    request_hash bytea NOT NULL,
    project_id uuid,
    origin_conversation_id uuid,
    origin_tool_call_id text,
    node_id uuid NOT NULL,
    agent_type text NOT NULL,
    runtime_mode text NOT NULL,
    working_directory text NOT NULL,
    execution_timeout_seconds integer DEFAULT 7200 NOT NULL,
    status text DEFAULT 'waiting_device' NOT NULL,
    status_reason text DEFAULT '' NOT NULL,
    created_by text NOT NULL,
    storage_generation text,
    native_session_id text,
    opened_at timestamptz,
    archived_at timestamptz,
    archive_requested_at timestamptz,
    stop_requested_at timestamptz,
    stop_confirmed_at timestamptz,
    last_reported_at timestamptz,
    last_worker_seq bigint DEFAULT 0 NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    last_activity_at timestamptz DEFAULT now() NOT NULL,
    model text DEFAULT '' NOT NULL,
    stop_code text,
    CONSTRAINT threads_check CHECK ((origin_conversation_id IS NULL) = (origin_tool_call_id IS NULL)),
    CONSTRAINT threads_check1 CHECK ((created_by <> 'project_agent'::text) OR ((project_id IS NOT NULL) AND (origin_conversation_id IS NOT NULL))),
    CONSTRAINT threads_client_thread_id_check CHECK ((octet_length(client_thread_id) >= 1) AND (octet_length(client_thread_id) <= 256)),
    CONSTRAINT threads_created_by_check CHECK (created_by IN ('employee', 'project_agent')),
    CONSTRAINT threads_execution_timeout_seconds_check CHECK (execution_timeout_seconds > 0),
    CONSTRAINT threads_last_worker_seq_check CHECK (last_worker_seq >= 0),
    CONSTRAINT threads_model_check CHECK (octet_length(model) <= 512),
    CONSTRAINT threads_request_hash_check CHECK (octet_length(request_hash) = 32),
    CONSTRAINT threads_status_check CHECK (status IN ('waiting_device', 'running', 'idle', 'stopped', 'unknown', 'archived')),
    CONSTRAINT threads_stop_code_check CHECK (stop_code IN ('user_stopped', 'forced_stop', 'interrupted', 'history_lost', 'folder_missing', 'start_failed')),
    CONSTRAINT threads_version_check CHECK (version > 0),
    CONSTRAINT threads_employee_id_client_thread_id_key UNIQUE (employee_id, client_thread_id),
    CONSTRAINT threads_employee_id_id_key UNIQUE (employee_id, id),
    CONSTRAINT threads_employee_id_id_node_id_key UNIQUE (employee_id, id, node_id),
    CONSTRAINT threads_origin_conversation_id_origin_tool_call_id_key UNIQUE (origin_conversation_id, origin_tool_call_id),
    CONSTRAINT threads_pkey PRIMARY KEY (id),
    CONSTRAINT threads_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT threads_employee_id_node_id_fkey FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id),
    CONSTRAINT threads_employee_id_origin_conversation_id_fkey FOREIGN KEY (employee_id, origin_conversation_id) REFERENCES conversations(employee_id, id),
    CONSTRAINT threads_employee_id_project_id_fkey FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id)
);
CREATE INDEX threads_activity ON threads USING btree (employee_id, last_activity_at DESC, id DESC);
CREATE INDEX threads_project ON threads USING btree (employee_id, project_id, last_activity_at DESC, id DESC);

CREATE TABLE thread_turns (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    worker_turn_seq bigint NOT NULL,
    initiator text NOT NULL,
    origin_tool_call_id text,
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    end_reason text,
    model text DEFAULT '' NOT NULL,
    token_usage json,
    CONSTRAINT thread_turns_check CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
    CONSTRAINT thread_turns_initiator_check CHECK (initiator IN ('employee', 'project_agent')),
    CONSTRAINT thread_turns_model_check CHECK (octet_length(model) <= 512),
    CONSTRAINT thread_turns_worker_turn_seq_check CHECK (worker_turn_seq > 0),
    CONSTRAINT thread_turns_employee_id_thread_id_id_key UNIQUE (employee_id, thread_id, id),
    CONSTRAINT thread_turns_employee_id_thread_id_id_worker_turn_seq_key UNIQUE (employee_id, thread_id, id, worker_turn_seq),
    CONSTRAINT thread_turns_employee_id_thread_id_worker_turn_seq_key UNIQUE (employee_id, thread_id, worker_turn_seq),
    CONSTRAINT thread_turns_pkey PRIMARY KEY (id),
    CONSTRAINT thread_turns_employee_id_thread_id_fkey FOREIGN KEY (employee_id, thread_id) REFERENCES threads(employee_id, id)
);
CREATE UNIQUE INDEX thread_one_active_turn ON thread_turns USING btree (thread_id) WHERE (ended_at IS NULL);

CREATE TABLE thread_messages (
    requested_model text DEFAULT '' NOT NULL,
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    client_message_id text NOT NULL,
    sender text NOT NULL,
    origin_tool_call_id text,
    content text NOT NULL,
    mode text DEFAULT 'queue' NOT NULL,
    status text DEFAULT 'accepted' NOT NULL,
    turn_id uuid,
    worker_turn_seq bigint,
    created_at timestamptz DEFAULT now() NOT NULL,
    model text DEFAULT '' NOT NULL,
    status_reason text DEFAULT '' NOT NULL,
    thinking jsonb,
    CONSTRAINT thread_messages_check CHECK ((turn_id IS NULL) = (worker_turn_seq IS NULL)),
    CONSTRAINT thread_messages_client_message_id_check CHECK ((octet_length(client_message_id) >= 1) AND (octet_length(client_message_id) <= 256)),
    CONSTRAINT thread_messages_content_check CHECK ((octet_length(content) >= 1) AND (octet_length(content) <= 65536)),
    CONSTRAINT thread_messages_mode_check CHECK (mode IN ('queue', 'steer')),
    CONSTRAINT thread_messages_model_check CHECK (octet_length(model) <= 512),
    CONSTRAINT thread_messages_sender_check CHECK (sender IN ('employee', 'project_agent')),
    CONSTRAINT thread_messages_status_check CHECK (status IN ('accepted', 'queued', 'sent', 'withdrawn', 'unknown')),
    CONSTRAINT thread_messages_status_reason_check CHECK (octet_length(status_reason) <= 4096),
    CONSTRAINT thread_messages_employee_id_thread_id_id_key UNIQUE (employee_id, thread_id, id),
    CONSTRAINT thread_messages_pkey PRIMARY KEY (id),
    CONSTRAINT thread_messages_thread_id_client_message_id_key UNIQUE (thread_id, client_message_id),
    CONSTRAINT thread_messages_employee_id_thread_id_fkey FOREIGN KEY (employee_id, thread_id) REFERENCES threads(employee_id, id),
    CONSTRAINT thread_messages_employee_id_thread_id_turn_id_worker_turn__fkey FOREIGN KEY (employee_id, thread_id, turn_id, worker_turn_seq) REFERENCES thread_turns(employee_id, thread_id, id, worker_turn_seq)
);

CREATE TABLE thread_turn_items (
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    worker_turn_seq bigint NOT NULL,
    item_id text NOT NULL,
    worker_seq bigint NOT NULL,
    ordinal bigint NOT NULL,
    parent_id text,
    type text NOT NULL,
    status text NOT NULL,
    title text,
    started_at timestamptz,
    completed_at timestamptz,
    data json NOT NULL,
    truncated boolean NOT NULL,
    original_bytes bigint NOT NULL,
    full_output json,
    CONSTRAINT thread_turn_items_data_check CHECK (octet_length((data)::text) <= 196608),
    CONSTRAINT thread_turn_items_ordinal_check CHECK (ordinal >= 0),
    CONSTRAINT thread_turn_items_original_bytes_check CHECK (original_bytes >= 0),
    CONSTRAINT thread_turn_items_worker_seq_check CHECK (worker_seq > 0),
    CONSTRAINT thread_turn_items_worker_turn_seq_check CHECK (worker_turn_seq > 0),
    CONSTRAINT thread_turn_items_employee_id_thread_id_worker_seq_key UNIQUE (employee_id, thread_id, worker_seq),
    CONSTRAINT thread_turn_items_pkey PRIMARY KEY (employee_id, thread_id, worker_turn_seq, item_id),
    CONSTRAINT thread_turn_items_employee_id_thread_id_worker_turn_seq_fkey FOREIGN KEY (employee_id, thread_id, worker_turn_seq) REFERENCES thread_turns(employee_id, thread_id, worker_turn_seq)
);
CREATE INDEX thread_turn_items_order ON thread_turn_items USING btree (employee_id, thread_id, worker_turn_seq, ordinal, worker_seq);

CREATE TABLE thread_replies (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    worker_seq bigint NOT NULL,
    turn_id uuid NOT NULL,
    worker_turn_seq bigint NOT NULL,
    content text NOT NULL,
    truncated boolean DEFAULT false NOT NULL,
    original_bytes bigint NOT NULL,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT thread_replies_attachments_check CHECK ((jsonb_typeof(attachments) = 'array'::text) AND (octet_length((attachments)::text) <= 4096)),
    CONSTRAINT thread_replies_check CHECK (
CASE
    WHEN ((metadata ->> 'encoding'::text) = 'base64'::text) THEN (original_bytes >= 0)
    ELSE (original_bytes >= octet_length(content))
END),
    CONSTRAINT thread_replies_content_check CHECK (
CASE
    WHEN ((metadata ->> 'encoding'::text) = 'base64'::text) THEN (octet_length(content) <= 45056)
    ELSE (octet_length(content) <= 32768)
END),
    CONSTRAINT thread_replies_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 4096)),
    CONSTRAINT thread_replies_worker_seq_check CHECK (worker_seq > 0),
    CONSTRAINT thread_replies_pkey PRIMARY KEY (id),
    CONSTRAINT thread_replies_thread_id_worker_seq_key UNIQUE (thread_id, worker_seq),
    CONSTRAINT thread_replies_employee_id_thread_id_fkey FOREIGN KEY (employee_id, thread_id) REFERENCES threads(employee_id, id),
    CONSTRAINT thread_replies_employee_id_thread_id_turn_id_worker_turn_s_fkey FOREIGN KEY (employee_id, thread_id, turn_id, worker_turn_seq) REFERENCES thread_turns(employee_id, thread_id, id, worker_turn_seq)
);

CREATE TABLE thread_events (
    id bigserial,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    kind text NOT NULL,
    actor text NOT NULL,
    actor_id text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT thread_events_pkey PRIMARY KEY (id),
    CONSTRAINT thread_events_employee_id_thread_id_fkey FOREIGN KEY (employee_id, thread_id) REFERENCES threads(employee_id, id)
);
CREATE INDEX thread_events_timeline ON thread_events USING btree (employee_id, thread_id, id);
CREATE TRIGGER thread_events_append_only BEFORE DELETE OR UPDATE ON thread_events FOR EACH ROW EXECUTE FUNCTION reject_project_history_mutation();

CREATE TABLE thread_reports (
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    event_id uuid NOT NULL,
    worker_seq bigint NOT NULL,
    payload_hash bytea NOT NULL,
    ack jsonb NOT NULL,
    CONSTRAINT thread_reports_payload_hash_check CHECK (octet_length(payload_hash) = 32),
    CONSTRAINT thread_reports_worker_seq_check CHECK (worker_seq > 0),
    CONSTRAINT thread_reports_pkey PRIMARY KEY (thread_id, event_id),
    CONSTRAINT thread_reports_thread_id_worker_seq_key UNIQUE (thread_id, worker_seq),
    CONSTRAINT thread_reports_employee_id_thread_id_fkey FOREIGN KEY (employee_id, thread_id) REFERENCES threads(employee_id, id)
);

CREATE TABLE thread_outbox (
    id bigserial,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    node_id uuid NOT NULL,
    message_id uuid NOT NULL,
    action text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    acked_at timestamptz,
    result jsonb,
    completed_at timestamptz,
    completion jsonb,
    created_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT thread_outbox_action_check CHECK (action IN ('open', 'message', 'withdraw', 'stop', 'resume', 'settings', 'answer')),
    CONSTRAINT thread_outbox_attempts_check CHECK (attempts >= 0),
    CONSTRAINT thread_outbox_message_id_key UNIQUE (message_id),
    CONSTRAINT thread_outbox_pkey PRIMARY KEY (id),
    CONSTRAINT thread_outbox_employee_id_thread_id_node_id_fkey FOREIGN KEY (employee_id, thread_id, node_id) REFERENCES threads(employee_id, id, node_id)
);
CREATE INDEX thread_outbox_node_due ON thread_outbox USING btree (node_id, next_attempt_at, id) WHERE (acked_at IS NULL);
CREATE INDEX thread_outbox_order ON thread_outbox USING btree (thread_id, id) WHERE (acked_at IS NULL);

CREATE TABLE thread_activity_probes (
    thread_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    checks jsonb DEFAULT '{}'::jsonb NOT NULL,
    acknowledged_seq bigint DEFAULT 0 NOT NULL,
    CONSTRAINT thread_activity_probes_pkey PRIMARY KEY (thread_id),
    CONSTRAINT thread_activity_probes_employee_id_thread_id_fkey FOREIGN KEY (employee_id, thread_id) REFERENCES threads(employee_id, id)
);

-- Execution

CREATE TABLE executions (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    node_id uuid NOT NULL,
    origin_conversation_id uuid NOT NULL,
    origin_tool_call_id text NOT NULL,
    request_hash bytea NOT NULL,
    command text NOT NULL,
    working_directory text NOT NULL,
    timeout_seconds integer NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    storage_generation text NOT NULL,
    last_report_seq bigint DEFAULT 0 NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    exit_code integer,
    reason text,
    output text,
    encoding text,
    total_bytes bigint,
    truncated boolean,
    full_output jsonb,
    stop_requested_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    wait_until timestamptz NOT NULL,
    created_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT executions_encoding_check CHECK (encoding = 'base64'::text),
    CONSTRAINT executions_status_check CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'unknown')),
    CONSTRAINT executions_timeout_seconds_check CHECK (timeout_seconds > 0),
    CONSTRAINT executions_employee_id_origin_conversation_id_origin_tool_c_key UNIQUE (employee_id, origin_conversation_id, origin_tool_call_id),
    CONSTRAINT executions_pkey PRIMARY KEY (id),
    CONSTRAINT executions_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT executions_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id),
    CONSTRAINT executions_origin_conversation_id_fkey FOREIGN KEY (origin_conversation_id) REFERENCES conversations(id),
    CONSTRAINT executions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE INDEX executions_project ON executions USING btree (employee_id, project_id, id);

CREATE TABLE execution_reports (
    execution_id uuid NOT NULL,
    event_id uuid NOT NULL,
    seq bigint NOT NULL,
    payload_hash bytea NOT NULL,
    ack jsonb NOT NULL,
    CONSTRAINT execution_reports_execution_id_seq_key UNIQUE (execution_id, seq),
    CONSTRAINT execution_reports_pkey PRIMARY KEY (execution_id, event_id),
    CONSTRAINT execution_reports_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
);

CREATE TABLE execution_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY,
    execution_id uuid NOT NULL,
    message_id uuid NOT NULL,
    action text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    acked_at timestamptz,
    result jsonb,
    CONSTRAINT execution_outbox_action_check CHECK (action IN ('start', 'stop')),
    CONSTRAINT execution_outbox_execution_id_action_key UNIQUE (execution_id, action),
    CONSTRAINT execution_outbox_message_id_key UNIQUE (message_id),
    CONSTRAINT execution_outbox_pkey PRIMARY KEY (id),
    CONSTRAINT execution_outbox_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
);

-- Project 记忆

CREATE TABLE project_memory_contexts (
    context_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    last_seq bigint NOT NULL,
    input_seq bigint NOT NULL,
    core_epoch bigint NOT NULL,
    expires_at timestamptz,
    request_hash text NOT NULL,
    snapshot jsonb NOT NULL,
    content_hash text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT project_memory_contexts_pkey PRIMARY KEY (context_id),
    CONSTRAINT project_memory_contexts_employee_id_conversation_id_fkey FOREIGN KEY (employee_id, conversation_id) REFERENCES conversations(employee_id, id),
    CONSTRAINT project_memory_contexts_employee_id_project_id_fkey FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id)
);
CREATE TRIGGER project_memory_contexts_append_only BEFORE DELETE OR UPDATE ON project_memory_contexts FOR EACH ROW EXECUTE FUNCTION reject_project_history_mutation();

CREATE TABLE project_memory_items (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    title text NOT NULL,
    current_revision bigint NOT NULL,
    status text NOT NULL,
    successor_id uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT project_memory_items_current_revision_check CHECK (current_revision > 0),
    CONSTRAINT project_memory_items_status_check CHECK (status IN ('candidate', 'active', 'superseded', 'disputed', 'retired')),
    CONSTRAINT project_memory_items_title_check CHECK ((char_length(title) >= 1) AND (char_length(title) <= 200)),
    CONSTRAINT project_memory_items_employee_id_id_key UNIQUE (employee_id, id),
    CONSTRAINT project_memory_items_employee_id_project_id_id_key UNIQUE (employee_id, project_id, id),
    CONSTRAINT project_memory_items_pkey PRIMARY KEY (id),
    CONSTRAINT project_memory_items_employee_id_project_id_fkey FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id),
    CONSTRAINT project_memory_items_employee_id_project_id_successor_id_fkey FOREIGN KEY (employee_id, project_id, successor_id) REFERENCES project_memory_items(employee_id, project_id, id)
);
CREATE INDEX project_memory_project ON project_memory_items USING btree (employee_id, project_id, id);

CREATE TABLE project_memory_changes (
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    request_hash text NOT NULL,
    action text NOT NULL,
    item_id uuid NOT NULL,
    before_item_id uuid,
    before_revision bigint NOT NULL,
    after_revision bigint NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT project_memory_changes_pkey PRIMARY KEY (employee_id, project_id, operation_id),
    CONSTRAINT project_memory_changes_employee_id_project_id_before_item__fkey FOREIGN KEY (employee_id, project_id, before_item_id) REFERENCES project_memory_items(employee_id, project_id, id),
    CONSTRAINT project_memory_changes_employee_id_project_id_item_id_fkey FOREIGN KEY (employee_id, project_id, item_id) REFERENCES project_memory_items(employee_id, project_id, id)
);
CREATE TRIGGER project_memory_changes_append_only BEFORE DELETE OR UPDATE ON project_memory_changes FOR EACH ROW EXECUTE FUNCTION reject_project_history_mutation();

CREATE TABLE project_memory_jobs (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    kind text NOT NULL,
    input_seq bigint NOT NULL,
    through_seq bigint NOT NULL,
    policy_version text DEFAULT '1' NOT NULL,
    source_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    cursor_index integer DEFAULT 0 NOT NULL,
    cursor_offset integer DEFAULT 0 NOT NULL,
    state text DEFAULT 'pending' NOT NULL,
    attempt_id uuid,
    claim_epoch bigint DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    waiting_reason text DEFAULT '' NOT NULL,
    last_error text DEFAULT '' NOT NULL,
    usage jsonb,
    updated_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT project_memory_jobs_kind_check CHECK (kind IN ('consolidation', 'embedding')),
    CONSTRAINT project_memory_jobs_state_check CHECK (state IN ('pending', 'claimed', 'running', 'completed', 'cancelled')),
    CONSTRAINT project_memory_jobs_conversation_id_kind_input_seq_policy_v_key UNIQUE (conversation_id, kind, input_seq, policy_version),
    CONSTRAINT project_memory_jobs_pkey PRIMARY KEY (id),
    CONSTRAINT project_memory_jobs_employee_id_conversation_id_fkey FOREIGN KEY (employee_id, conversation_id) REFERENCES conversations(employee_id, id),
    CONSTRAINT project_memory_jobs_employee_id_project_id_fkey FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id)
);
CREATE INDEX project_memory_jobs_due ON project_memory_jobs USING btree (next_attempt_at) WHERE (state = 'pending'::text);

CREATE TABLE project_memory_chunks (
    job_id uuid NOT NULL,
    cursor_index integer NOT NULL,
    cursor_offset integer NOT NULL,
    attempt_id uuid NOT NULL,
    request_hash text NOT NULL,
    result jsonb NOT NULL,
    CONSTRAINT project_memory_chunks_pkey PRIMARY KEY (job_id, cursor_index, cursor_offset),
    CONSTRAINT project_memory_chunks_job_id_fkey FOREIGN KEY (job_id) REFERENCES project_memory_jobs(id)
);

CREATE TABLE project_memory_revisions (
    item_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    revision bigint NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    kind text NOT NULL,
    topic text DEFAULT '' NOT NULL,
    conditions text DEFAULT '' NOT NULL,
    semantic_key text DEFAULT '' NOT NULL,
    core boolean DEFAULT false NOT NULL,
    basis text NOT NULL,
    valid_from timestamptz,
    valid_until timestamptz,
    time_precision text DEFAULT 'unknown' NOT NULL,
    author text NOT NULL,
    source_seq bigint,
    action text NOT NULL,
    reason text DEFAULT '' NOT NULL,
    status text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT project_memory_revisions_author_check CHECK (author IN ('user', 'agent', 'background')),
    CONSTRAINT project_memory_revisions_basis_check CHECK (basis IN ('explicit', 'observed', 'inferred')),
    CONSTRAINT project_memory_revisions_check CHECK ((valid_from IS NULL) OR (valid_until IS NULL) OR (valid_from < valid_until)),
    CONSTRAINT project_memory_revisions_content_check CHECK (octet_length(content) <= 65536),
    CONSTRAINT project_memory_revisions_kind_check CHECK (kind IN ('preference', 'fact', 'decision', 'lesson')),
    CONSTRAINT project_memory_revisions_revision_check CHECK (revision > 0),
    CONSTRAINT project_memory_revisions_employee_id_project_id_item_id_rev_key UNIQUE (employee_id, project_id, item_id, revision),
    CONSTRAINT project_memory_revisions_pkey PRIMARY KEY (item_id, revision),
    CONSTRAINT project_memory_revisions_employee_id_project_id_item_id_fkey FOREIGN KEY (employee_id, project_id, item_id) REFERENCES project_memory_items(employee_id, project_id, id)
);
CREATE TRIGGER project_memory_revisions_append_only BEFORE DELETE OR UPDATE ON project_memory_revisions FOR EACH ROW EXECUTE FUNCTION reject_project_history_mutation();

CREATE TABLE project_memory_embeddings (
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    item_id uuid NOT NULL,
    revision bigint NOT NULL,
    config_id uuid NOT NULL,
    embedding_text_hash text NOT NULL,
    state text DEFAULT 'pending' NOT NULL,
    dimensions integer,
    embedding public.vector,
    diagnostic text DEFAULT '' NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT project_memory_embeddings_check CHECK ((state = 'ready'::text) = ((embedding IS NOT NULL) AND (dimensions IS NOT NULL))),
    CONSTRAINT project_memory_embeddings_check1 CHECK ((embedding IS NULL) OR (public.vector_dims(embedding) = dimensions)),
    CONSTRAINT project_memory_embeddings_diagnostic_check CHECK (octet_length(diagnostic) <= 256),
    CONSTRAINT project_memory_embeddings_dimensions_check CHECK ((dimensions >= 1) AND (dimensions <= 8192)),
    CONSTRAINT project_memory_embeddings_state_check CHECK (state IN ('pending', 'ready')),
    CONSTRAINT project_memory_embeddings_pkey PRIMARY KEY (employee_id, project_id, item_id, revision, config_id),
    CONSTRAINT project_memory_embeddings_employee_id_project_id_item_id_r_fkey FOREIGN KEY (employee_id, project_id, item_id, revision) REFERENCES project_memory_revisions(employee_id, project_id, item_id, revision)
);

CREATE TABLE project_memory_sources (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    source_key text NOT NULL,
    source_type text NOT NULL,
    role text NOT NULL,
    text text NOT NULL,
    source_hash text NOT NULL,
    source_seq bigint,
    input_id bigint,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT project_memory_sources_employee_id_project_id_id_key UNIQUE (employee_id, project_id, id),
    CONSTRAINT project_memory_sources_employee_id_project_id_source_key_key UNIQUE (employee_id, project_id, source_key),
    CONSTRAINT project_memory_sources_pkey PRIMARY KEY (id),
    CONSTRAINT project_memory_sources_employee_id_project_id_fkey FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id)
);
CREATE TRIGGER project_memory_sources_append_only BEFORE DELETE OR UPDATE ON project_memory_sources FOR EACH ROW EXECUTE FUNCTION reject_project_history_mutation();

CREATE TABLE project_memory_evidence (
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    item_id uuid NOT NULL,
    revision bigint NOT NULL,
    source_id uuid NOT NULL,
    start_byte bigint NOT NULL,
    end_byte bigint NOT NULL,
    source_hash text NOT NULL,
    CONSTRAINT project_memory_evidence_check CHECK ((start_byte >= 0) AND (end_byte > start_byte)),
    CONSTRAINT project_memory_evidence_pkey PRIMARY KEY (item_id, revision, source_id, start_byte, end_byte),
    CONSTRAINT project_memory_evidence_employee_id_project_id_item_id_rev_fkey FOREIGN KEY (employee_id, project_id, item_id, revision) REFERENCES project_memory_revisions(employee_id, project_id, item_id, revision),
    CONSTRAINT project_memory_evidence_employee_id_project_id_source_id_fkey FOREIGN KEY (employee_id, project_id, source_id) REFERENCES project_memory_sources(employee_id, project_id, id)
);
CREATE TRIGGER project_memory_evidence_append_only BEFORE DELETE OR UPDATE ON project_memory_evidence FOR EACH ROW EXECUTE FUNCTION reject_project_history_mutation();

CREATE TABLE project_memory_search_documents (
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    document_id text NOT NULL,
    item_id uuid,
    revision bigint,
    source_id uuid,
    start_byte bigint,
    end_byte bigint,
    fields jsonb NOT NULL,
    terms tsvector NOT NULL,
    snippet text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT project_memory_search_documents_check CHECK ((item_id IS NULL) <> (source_id IS NULL)),
    CONSTRAINT project_memory_search_documents_pkey PRIMARY KEY (employee_id, project_id, document_id),
    CONSTRAINT project_memory_search_documen_employee_id_project_id_item__fkey FOREIGN KEY (employee_id, project_id, item_id, revision) REFERENCES project_memory_revisions(employee_id, project_id, item_id, revision),
    CONSTRAINT project_memory_search_documen_employee_id_project_id_sourc_fkey FOREIGN KEY (employee_id, project_id, source_id) REFERENCES project_memory_sources(employee_id, project_id, id),
    CONSTRAINT project_memory_search_documents_employee_id_project_id_fkey FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id)
);
CREATE INDEX project_memory_search_terms ON project_memory_search_documents USING gin (terms);

CREATE TABLE project_memory_state (
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    knowledge_epoch bigint DEFAULT 0 NOT NULL,
    core_epoch bigint DEFAULT 0 NOT NULL,
    search_generation bigint DEFAULT 0 NOT NULL,
    CONSTRAINT project_memory_state_pkey PRIMARY KEY (employee_id, project_id),
    CONSTRAINT project_memory_state_employee_id_project_id_fkey FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id)
);

CREATE TABLE project_memory_suppressions (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    item_id uuid NOT NULL,
    revision bigint NOT NULL,
    kind text NOT NULL,
    retirement_id uuid,
    semantic_key text NOT NULL,
    value_hash text NOT NULL,
    evidence jsonb NOT NULL,
    released_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT project_memory_suppressions_kind_check CHECK (kind IN ('retired', 'retracted')),
    CONSTRAINT project_memory_suppressions_employee_id_project_id_id_key UNIQUE (employee_id, project_id, id),
    CONSTRAINT project_memory_suppressions_pkey PRIMARY KEY (id),
    CONSTRAINT project_memory_suppressions_employee_id_project_id_item_id_fkey FOREIGN KEY (employee_id, project_id, item_id, revision) REFERENCES project_memory_revisions(employee_id, project_id, item_id, revision),
    CONSTRAINT project_memory_suppressions_employee_id_project_id_retirem_fkey FOREIGN KEY (employee_id, project_id, retirement_id) REFERENCES project_memory_suppressions(employee_id, project_id, id)
);

-- 网页通知

CREATE TABLE browser_notifications (
    employee_id uuid NOT NULL,
    seq bigint,
    event_id uuid NOT NULL,
    source_key text NOT NULL,
    event jsonb NOT NULL,
    created_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    published_at timestamptz,
    CONSTRAINT browser_notifications_check CHECK ((seq IS NOT NULL) OR (published_at IS NULL)),
    CONSTRAINT browser_notifications_seq_check CHECK (seq > 0),
    CONSTRAINT browser_notifications_employee_id_seq_key UNIQUE (employee_id, seq),
    CONSTRAINT browser_notifications_employee_id_source_key_key UNIQUE (employee_id, source_key),
    CONSTRAINT browser_notifications_pkey PRIMARY KEY (event_id),
    CONSTRAINT browser_notifications_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id)
);
CREATE INDEX browser_notification_intents ON browser_notifications USING btree (employee_id, created_at, event_id) WHERE (seq IS NULL);
CREATE INDEX browser_notifications_pending ON browser_notifications USING btree (employee_id, seq) WHERE ((published_at IS NULL) AND (seq IS NOT NULL));

CREATE TABLE browser_notification_cursors (
    employee_id uuid NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL,
    CONSTRAINT browser_notification_cursors_last_seq_check CHECK (last_seq >= 0),
    CONSTRAINT browser_notification_cursors_pkey PRIMARY KEY (employee_id),
    CONSTRAINT browser_notification_cursors_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id)
);

-- 互相引用的外键在相关表都建好后补上
ALTER TABLE employee_settings ADD CONSTRAINT employee_settings_default_node_fk FOREIGN KEY (employee_id, default_device_node_id) REFERENCES nodes(employee_id, id);
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_memory_job_id_fkey FOREIGN KEY (memory_job_id) REFERENCES project_memory_jobs(id);
ALTER TABLE project_memory_items ADD CONSTRAINT project_memory_current_revision_fk FOREIGN KEY (employee_id, project_id, id, current_revision) REFERENCES project_memory_revisions(employee_id, project_id, item_id, revision) DEFERRABLE INITIALLY DEFERRED;

