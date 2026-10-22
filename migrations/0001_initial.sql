CREATE FUNCTION reject_project_history_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION '对话事件和记忆修订只允许追加' USING ERRCODE = '23514';
END;
$$;

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
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    end_reason text,
    stop_acked_at timestamp with time zone,
    stop_requested_at timestamp with time zone,
    command_next_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    command_attempts integer DEFAULT 0 NOT NULL,
    CONSTRAINT agent_runs_command_attempts_check CHECK ((command_attempts >= 0)),
    CONSTRAINT agent_runs_lease_epoch_check CHECK ((lease_epoch > 0)),
    CONSTRAINT agent_runs_state_check CHECK ((state = ANY (ARRAY['starting'::text, 'running'::text, 'finished'::text, 'lost'::text, 'failed'::text])))
);

CREATE TABLE attention_requests (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    origin_tool_call_id text,
    source text NOT NULL,
    condition_type text,
    condition_object_id uuid,
    title text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    options jsonb DEFAULT '[]'::jsonb NOT NULL,
    allow_text boolean DEFAULT false NOT NULL,
    action_url text DEFAULT ''::text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    resolution jsonb,
    resolved_at timestamp with time zone,
    withdraw_reason text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    thread_id uuid,
    CONSTRAINT attention_requests_content_check CHECK ((octet_length(content) <= 32768)),
    CONSTRAINT attention_requests_options_check CHECK (((jsonb_typeof(options) = 'array'::text) AND (jsonb_array_length(options) <= 5))),
    CONSTRAINT attention_requests_source_check CHECK ((source = ANY (ARRAY['agent'::text, 'system'::text]))),
    CONSTRAINT attention_requests_state_check CHECK ((state = ANY (ARRAY['open'::text, 'answered'::text, 'closed'::text, 'withdrawn'::text, 'resolved'::text]))),
    CONSTRAINT attention_requests_summary_check CHECK ((char_length(summary) <= 280)),
    CONSTRAINT attention_requests_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 120))),
    CONSTRAINT attention_requests_version_check CHECK ((version > 0)),
    CONSTRAINT attention_source CHECK ((((source = 'agent'::text) AND (origin_tool_call_id IS NOT NULL) AND (condition_type IS NULL) AND (condition_object_id IS NULL) AND (state <> 'resolved'::text)) OR ((source = 'system'::text) AND (origin_tool_call_id IS NULL) AND (condition_type IS NOT NULL) AND (condition_type = 'project_needs_attention'::text) AND (condition_object_id IS NOT NULL) AND (condition_object_id = project_id) AND (thread_id IS NULL) AND (NOT allow_text) AND (options = '[]'::jsonb) AND (state <> 'answered'::text))))
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
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_events_check CHECK (((kind <> 'tool_result'::text) OR (tool_call_id IS NOT NULL))),
    CONSTRAINT conversation_events_kind_check CHECK ((kind = ANY (ARRAY['input'::text, 'assistant'::text, 'tool_result'::text, 'compaction'::text]))),
    CONSTRAINT conversation_events_lease_epoch_check CHECK ((lease_epoch >= 0)),
    CONSTRAINT conversation_events_payload_check CHECK ((octet_length((payload)::text) <= 163840)),
    CONSTRAINT conversation_events_seq_check CHECK ((seq > 0))
);

CREATE TABLE conversations (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    kind text DEFAULT 'primary'::text NOT NULL,
    next_seq bigint DEFAULT 1 NOT NULL,
    compaction_seq bigint,
    state text DEFAULT 'active'::text NOT NULL,
    attention_reason text,
    failure_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    CONSTRAINT conversations_check CHECK (((compaction_seq > 0) AND (compaction_seq < next_seq))),
    CONSTRAINT conversations_failure_count_check CHECK ((failure_count >= 0)),
    CONSTRAINT conversations_kind_check CHECK ((kind = 'primary'::text)),
    CONSTRAINT conversations_next_seq_check CHECK ((next_seq > 0)),
    CONSTRAINT conversations_state_check CHECK ((state = ANY (ARRAY['active'::text, 'needs_attention'::text])))
);

CREATE TABLE employee_settings (
    employee_id uuid NOT NULL,
    default_device_node_id uuid,
    updated_at timestamp with time zone NOT NULL
);

CREATE TABLE employees (
    id uuid NOT NULL,
    username text NOT NULL,
    display_name text NOT NULL,
    auth_source text NOT NULL,
    external_subject text,
    password_hash text,
    must_change_password boolean NOT NULL,
    password_changed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT employees_auth_source_shape CHECK ((auth_source ~ '^[a-z][a-z0-9._-]{0,62}$'::text)),
    CONSTRAINT employees_display_name_text CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 80) AND (display_name !~ '[[:cntrl:]]'::text))),
    CONSTRAINT employees_secret_shape CHECK ((((auth_source = 'local'::text) AND (password_hash ~~ '$argon2id$%'::text) AND (external_subject IS NULL)) OR ((auth_source <> 'local'::text) AND (password_hash IS NULL) AND (external_subject IS NOT NULL)))),
    CONSTRAINT employees_username_shape CHECK ((username ~ '^[a-z][a-z0-9._-]{0,62}$'::text))
);

CREATE TABLE login_sessions (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    csrf_hash bytea NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT login_sessions_hash_length CHECK (((octet_length(token_hash) = 32) AND (octet_length(csrf_hash) = 32)))
);

CREATE TABLE node_credentials (
    id uuid NOT NULL,
    node_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    version integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT node_credentials_expires_after_create CHECK ((expires_at > created_at)),
    CONSTRAINT node_credentials_version_positive CHECK ((version >= 1))
);

CREATE TABLE node_enrollments (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT node_enrollments_expires_after_create CHECK ((expires_at > created_at)),
    CONSTRAINT node_enrollments_hash_length CHECK ((octet_length(token_hash) = 32))
);

CREATE TABLE node_presence (
    node_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    online boolean NOT NULL,
    synced boolean NOT NULL,
    incarnation text NOT NULL,
    conn_id text NOT NULL,
    last_contact_at timestamp with time zone,
    status_updated_at timestamp with time zone NOT NULL,
    CONSTRAINT node_presence_conn_len CHECK (((char_length(conn_id) >= 1) AND (char_length(conn_id) <= 80))),
    CONSTRAINT node_presence_incarnation_len CHECK (((char_length(incarnation) >= 1) AND (char_length(incarnation) <= 80)))
);

CREATE SEQUENCE node_registration_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE node_revocations (
    id uuid NOT NULL,
    node_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    actor_employee_id uuid NOT NULL,
    credential_id uuid NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    applied_at timestamp with time zone,
    CONSTRAINT node_revocations_applied_after CHECK (((applied_at IS NULL) OR (applied_at >= requested_at)))
);

CREATE TABLE node_runtime_reports (
    node_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    report_version bigint NOT NULL,
    reported_at timestamp with time zone NOT NULL,
    report jsonb NOT NULL,
    CONSTRAINT node_runtime_reports_size CHECK ((octet_length((report)::text) <= 65536)),
    CONSTRAINT node_runtime_reports_version_positive CHECK ((report_version > 0))
);

CREATE TABLE nodes (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    display_name text NOT NULL,
    system_name text NOT NULL,
    capabilities text[] NOT NULL,
    registration_seq bigint NOT NULL,
    registered_at timestamp with time zone NOT NULL,
    credential_version integer NOT NULL,
    revoked_at timestamp with time zone,
    default_agent_type text,
    CONSTRAINT nodes_capabilities_count CHECK ((cardinality(capabilities) <= 32)),
    CONSTRAINT nodes_credential_version_positive CHECK ((credential_version >= 1)),
    CONSTRAINT nodes_default_agent_type_shape CHECK (((default_agent_type IS NULL) OR (default_agent_type ~ '^[a-z][a-z0-9._-]{0,63}$'::text))),
    CONSTRAINT nodes_display_name_text CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 80) AND (display_name !~ '[[:cntrl:]]'::text))),
    CONSTRAINT nodes_registration_seq_positive CHECK ((registration_seq > 0)),
    CONSTRAINT nodes_system_name CHECK ((system_name = ANY (ARRAY['windows'::text, 'macos'::text, 'linux'::text])))
);

CREATE TABLE project_agent_input_queue (
    id bigint NOT NULL,
    employee_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    source_type text NOT NULL,
    source_key text NOT NULL,
    payload jsonb NOT NULL,
    payload_hash bytea NOT NULL,
    delivered_seq bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    wake_required boolean DEFAULT false NOT NULL,
    wake_next_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    wake_attempts integer DEFAULT 0 NOT NULL,
    CONSTRAINT project_agent_input_queue_delivered_seq_check CHECK ((delivered_seq > 0)),
    CONSTRAINT project_agent_input_queue_payload_check CHECK ((octet_length((payload)::text) <= 73728)),
    CONSTRAINT project_agent_input_queue_payload_hash_check CHECK ((octet_length(payload_hash) = 32)),
    CONSTRAINT project_agent_input_queue_source_type_check CHECK ((source_type = ANY (ARRAY['user_message'::text, 'attention_answer'::text, 'memory_updated'::text, 'project_updated'::text, 'thread_reply'::text, 'turn_ended'::text, 'thread_message_failed'::text]))),
    CONSTRAINT project_agent_input_queue_wake_attempts_check CHECK ((wake_attempts >= 0)),
    CONSTRAINT project_input_source_size CHECK ((((source_type <> ALL (ARRAY['thread_reply'::text, 'thread_message_failed'::text])) OR (octet_length((payload)::text) <= 40960)) AND ((source_type <> 'turn_ended'::text) OR (octet_length((payload)::text) <=
CASE
    WHEN (payload ? 'command_result'::text) THEN 73728
    ELSE 4096
END)) AND ((source_type <> 'memory_updated'::text) OR (octet_length((payload)::text) <= 1024)) AND ((source_type <> 'project_updated'::text) OR (octet_length((payload)::text) <= 4096)) AND ((source_type <> 'attention_answer'::text) OR (octet_length((payload)::text) <= 32768))))
);

CREATE SEQUENCE project_agent_input_queue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE project_agent_input_queue_id_seq OWNED BY project_agent_input_queue.id;

CREATE TABLE project_agents (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    provider text DEFAULT ''::text NOT NULL,
    model text DEFAULT ''::text NOT NULL,
    prompt_version text DEFAULT '1'::text NOT NULL,
    lease_run_id uuid,
    lease_epoch bigint DEFAULT 0 NOT NULL,
    lease_until timestamp with time zone,
    CONSTRAINT project_agents_check CHECK (((lease_run_id IS NULL) = (lease_until IS NULL))),
    CONSTRAINT project_agents_lease_epoch_check CHECK ((lease_epoch >= 0))
);

CREATE TABLE project_memory_entries (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    project_id uuid NOT NULL,
    title text NOT NULL,
    current_revision bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_memory_entries_current_revision_check CHECK ((current_revision > 0)),
    CONSTRAINT project_memory_entries_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200) AND (title !~ '[[:cntrl:]]'::text)))
);

CREATE TABLE project_memory_revisions (
    entry_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    revision bigint NOT NULL,
    content text NOT NULL,
    author text NOT NULL,
    source_seq bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_memory_revisions_author_check CHECK ((author = ANY (ARRAY['agent'::text, 'user'::text]))),
    CONSTRAINT project_memory_revisions_revision_check CHECK ((revision > 0)),
    CONSTRAINT project_memory_revisions_source_seq_check CHECK ((source_seq > 0))
);

CREATE TABLE projects (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    title text NOT NULL,
    goal text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT projects_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'archived'::text]))),
    CONSTRAINT projects_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200) AND (title !~ '[[:cntrl:]]'::text))),
    CONSTRAINT projects_version_check CHECK ((version > 0))
);

CREATE TABLE thread_events (
    id bigint NOT NULL,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    kind text NOT NULL,
    actor text NOT NULL,
    actor_id text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE thread_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE thread_events_id_seq OWNED BY thread_events.id;

CREATE TABLE thread_messages (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    client_message_id text NOT NULL,
    sender text NOT NULL,
    origin_tool_call_id text,
    content text NOT NULL,
    mode text DEFAULT 'queue'::text NOT NULL,
    status text DEFAULT 'accepted'::text NOT NULL,
    turn_id uuid,
    worker_turn_seq bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    model text DEFAULT ''::text NOT NULL,
    status_reason text DEFAULT ''::text NOT NULL,
    CONSTRAINT thread_messages_check CHECK (((turn_id IS NULL) = (worker_turn_seq IS NULL))),
    CONSTRAINT thread_messages_client_message_id_check CHECK (((octet_length(client_message_id) >= 1) AND (octet_length(client_message_id) <= 256))),
    CONSTRAINT thread_messages_content_check CHECK (((octet_length(content) >= 1) AND (octet_length(content) <= 65536))),
    CONSTRAINT thread_messages_mode_check CHECK ((mode = ANY (ARRAY['queue'::text, 'steer'::text]))),
    CONSTRAINT thread_messages_model_check CHECK ((octet_length(model) <= 512)),
    CONSTRAINT thread_messages_sender_check CHECK ((sender = ANY (ARRAY['employee'::text, 'project_agent'::text]))),
    CONSTRAINT thread_messages_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'queued'::text, 'sent'::text, 'withdrawn'::text, 'unknown'::text]))),
    CONSTRAINT thread_messages_status_reason_check CHECK ((octet_length(status_reason) <= 4096))
);

CREATE TABLE thread_outbox (
    id bigint NOT NULL,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    node_id uuid NOT NULL,
    message_id uuid NOT NULL,
    action text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    acked_at timestamp with time zone,
    result jsonb,
    CONSTRAINT thread_outbox_action_check CHECK ((action = ANY (ARRAY['open'::text, 'message'::text, 'withdraw'::text, 'stop'::text]))),
    CONSTRAINT thread_outbox_attempts_check CHECK ((attempts >= 0))
);

CREATE SEQUENCE thread_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE thread_outbox_id_seq OWNED BY thread_outbox.id;

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
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT thread_replies_attachments_check CHECK (((jsonb_typeof(attachments) = 'array'::text) AND (octet_length((attachments)::text) <= 4096))),
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
    CONSTRAINT thread_replies_metadata_check CHECK (((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 4096))),
    CONSTRAINT thread_replies_worker_seq_check CHECK ((worker_seq > 0))
);

CREATE TABLE thread_reports (
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    event_id uuid NOT NULL,
    worker_seq bigint NOT NULL,
    payload_hash bytea NOT NULL,
    ack jsonb NOT NULL,
    CONSTRAINT thread_reports_payload_hash_check CHECK ((octet_length(payload_hash) = 32)),
    CONSTRAINT thread_reports_worker_seq_check CHECK ((worker_seq > 0))
);

CREATE TABLE thread_turns (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    worker_turn_seq bigint NOT NULL,
    initiator text NOT NULL,
    origin_tool_call_id text,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    end_reason text,
    model text DEFAULT ''::text NOT NULL,
    CONSTRAINT thread_turns_check CHECK (((ended_at IS NULL) = (end_reason IS NULL))),
    CONSTRAINT thread_turns_initiator_check CHECK ((initiator = ANY (ARRAY['employee'::text, 'project_agent'::text]))),
    CONSTRAINT thread_turns_model_check CHECK ((octet_length(model) <= 512)),
    CONSTRAINT thread_turns_worker_turn_seq_check CHECK ((worker_turn_seq > 0))
);

CREATE TABLE threads (
    id uuid NOT NULL,
    employee_id uuid NOT NULL,
    client_thread_id text NOT NULL,
    request_hash bytea NOT NULL,
    project_id uuid,
    origin_conversation_id uuid,
    origin_tool_call_id text,
    node_id uuid NOT NULL,
    agent_type text NOT NULL,
    working_directory text NOT NULL,
    execution_timeout_seconds integer DEFAULT 7200 NOT NULL,
    status text DEFAULT 'waiting_device'::text NOT NULL,
    status_reason text DEFAULT ''::text NOT NULL,
    created_by text NOT NULL,
    storage_generation text,
    native_session_id text,
    opened_at timestamp with time zone,
    archived_at timestamp with time zone,
    archive_requested_at timestamp with time zone,
    stop_requested_at timestamp with time zone,
    stop_confirmed_at timestamp with time zone,
    last_reported_at timestamp with time zone,
    last_worker_seq bigint DEFAULT 0 NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    exec_wait_until timestamp with time zone,
    model text DEFAULT ''::text NOT NULL,
    CONSTRAINT threads_check CHECK (((origin_conversation_id IS NULL) = (origin_tool_call_id IS NULL))),
    CONSTRAINT threads_check1 CHECK (((created_by <> 'project_agent'::text) OR ((project_id IS NOT NULL) AND (origin_conversation_id IS NOT NULL)))),
    CONSTRAINT threads_client_thread_id_check CHECK (((octet_length(client_thread_id) >= 1) AND (octet_length(client_thread_id) <= 256))),
    CONSTRAINT threads_created_by_check CHECK ((created_by = ANY (ARRAY['employee'::text, 'project_agent'::text]))),
    CONSTRAINT threads_execution_timeout_seconds_check CHECK ((execution_timeout_seconds > 0)),
    CONSTRAINT threads_last_worker_seq_check CHECK ((last_worker_seq >= 0)),
    CONSTRAINT threads_model_check CHECK ((octet_length(model) <= 512)),
    CONSTRAINT threads_request_hash_check CHECK ((octet_length(request_hash) = 32)),
    CONSTRAINT threads_status_check CHECK ((status = ANY (ARRAY['waiting_device'::text, 'running'::text, 'idle'::text, 'stopped'::text, 'unknown'::text, 'archived'::text]))),
    CONSTRAINT threads_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY project_agent_input_queue ALTER COLUMN id SET DEFAULT nextval('project_agent_input_queue_id_seq'::regclass);

ALTER TABLE ONLY thread_events ALTER COLUMN id SET DEFAULT nextval('thread_events_id_seq'::regclass);

ALTER TABLE ONLY thread_outbox ALTER COLUMN id SET DEFAULT nextval('thread_outbox_id_seq'::regclass);

ALTER TABLE ONLY agent_runs
    ADD CONSTRAINT agent_runs_agent_id_lease_epoch_key UNIQUE (agent_id, lease_epoch);

ALTER TABLE ONLY agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY attention_requests
    ADD CONSTRAINT attention_requests_conversation_id_origin_tool_call_id_key UNIQUE (conversation_id, origin_tool_call_id);

ALTER TABLE ONLY attention_requests
    ADD CONSTRAINT attention_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY conversation_events
    ADD CONSTRAINT conversation_events_conversation_id_client_event_id_key UNIQUE (conversation_id, client_event_id);

ALTER TABLE ONLY conversation_events
    ADD CONSTRAINT conversation_events_employee_id_conversation_id_seq_key UNIQUE (employee_id, conversation_id, seq);

ALTER TABLE ONLY conversation_events
    ADD CONSTRAINT conversation_events_pkey PRIMARY KEY (conversation_id, seq);

ALTER TABLE ONLY conversations
    ADD CONSTRAINT conversations_agent_id_kind_key UNIQUE (agent_id, kind);

ALTER TABLE ONLY conversations
    ADD CONSTRAINT conversations_employee_id_id_key UNIQUE (employee_id, id);

ALTER TABLE ONLY conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY employee_settings
    ADD CONSTRAINT employee_settings_pkey PRIMARY KEY (employee_id);

ALTER TABLE ONLY employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);

ALTER TABLE ONLY employees
    ADD CONSTRAINT employees_username_unique UNIQUE (username);

ALTER TABLE ONLY login_sessions
    ADD CONSTRAINT login_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY login_sessions
    ADD CONSTRAINT login_sessions_token_hash_unique UNIQUE (token_hash);

ALTER TABLE ONLY node_credentials
    ADD CONSTRAINT node_credentials_node_version_unique UNIQUE (node_id, version);

ALTER TABLE ONLY node_credentials
    ADD CONSTRAINT node_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY node_enrollments
    ADD CONSTRAINT node_enrollments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY node_enrollments
    ADD CONSTRAINT node_enrollments_token_hash_unique UNIQUE (token_hash);

ALTER TABLE ONLY node_presence
    ADD CONSTRAINT node_presence_pkey PRIMARY KEY (node_id);

ALTER TABLE ONLY node_revocations
    ADD CONSTRAINT node_revocations_credential_unique UNIQUE (credential_id);

ALTER TABLE ONLY node_revocations
    ADD CONSTRAINT node_revocations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY node_runtime_reports
    ADD CONSTRAINT node_runtime_reports_pkey PRIMARY KEY (node_id);

ALTER TABLE ONLY nodes
    ADD CONSTRAINT nodes_employee_node_unique UNIQUE (employee_id, id);

ALTER TABLE ONLY nodes
    ADD CONSTRAINT nodes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY nodes
    ADD CONSTRAINT nodes_registration_seq_unique UNIQUE (registration_seq);

ALTER TABLE ONLY project_agent_input_queue
    ADD CONSTRAINT project_agent_input_queue_agent_id_source_key_key UNIQUE (agent_id, source_key);

ALTER TABLE ONLY project_agent_input_queue
    ADD CONSTRAINT project_agent_input_queue_pkey PRIMARY KEY (id);

ALTER TABLE ONLY project_agents
    ADD CONSTRAINT project_agents_employee_id_id_key UNIQUE (employee_id, id);

ALTER TABLE ONLY project_agents
    ADD CONSTRAINT project_agents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY project_agents
    ADD CONSTRAINT project_agents_project_id_key UNIQUE (project_id);

ALTER TABLE ONLY project_memory_entries
    ADD CONSTRAINT project_memory_entries_employee_id_id_key UNIQUE (employee_id, id);

ALTER TABLE ONLY project_memory_entries
    ADD CONSTRAINT project_memory_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY project_memory_revisions
    ADD CONSTRAINT project_memory_revisions_pkey PRIMARY KEY (entry_id, revision);

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_employee_id_id_key UNIQUE (employee_id, id);

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY thread_events
    ADD CONSTRAINT thread_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY thread_messages
    ADD CONSTRAINT thread_messages_employee_id_thread_id_id_key UNIQUE (employee_id, thread_id, id);

ALTER TABLE ONLY thread_messages
    ADD CONSTRAINT thread_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY thread_messages
    ADD CONSTRAINT thread_messages_thread_id_client_message_id_key UNIQUE (thread_id, client_message_id);

ALTER TABLE ONLY thread_outbox
    ADD CONSTRAINT thread_outbox_message_id_key UNIQUE (message_id);

ALTER TABLE ONLY thread_outbox
    ADD CONSTRAINT thread_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY thread_replies
    ADD CONSTRAINT thread_replies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY thread_replies
    ADD CONSTRAINT thread_replies_thread_id_worker_seq_key UNIQUE (thread_id, worker_seq);

ALTER TABLE ONLY thread_reports
    ADD CONSTRAINT thread_reports_pkey PRIMARY KEY (thread_id, event_id);

ALTER TABLE ONLY thread_reports
    ADD CONSTRAINT thread_reports_thread_id_worker_seq_key UNIQUE (thread_id, worker_seq);

ALTER TABLE ONLY thread_turns
    ADD CONSTRAINT thread_turns_employee_id_thread_id_id_key UNIQUE (employee_id, thread_id, id);

ALTER TABLE ONLY thread_turns
    ADD CONSTRAINT thread_turns_employee_id_thread_id_id_worker_turn_seq_key UNIQUE (employee_id, thread_id, id, worker_turn_seq);

ALTER TABLE ONLY thread_turns
    ADD CONSTRAINT thread_turns_employee_id_thread_id_worker_turn_seq_key UNIQUE (employee_id, thread_id, worker_turn_seq);

ALTER TABLE ONLY thread_turns
    ADD CONSTRAINT thread_turns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY threads
    ADD CONSTRAINT threads_employee_id_client_thread_id_key UNIQUE (employee_id, client_thread_id);

ALTER TABLE ONLY threads
    ADD CONSTRAINT threads_employee_id_id_key UNIQUE (employee_id, id);

ALTER TABLE ONLY threads
    ADD CONSTRAINT threads_employee_id_id_node_id_key UNIQUE (employee_id, id, node_id);

ALTER TABLE ONLY threads
    ADD CONSTRAINT threads_origin_conversation_id_origin_tool_call_id_key UNIQUE (origin_conversation_id, origin_tool_call_id);

ALTER TABLE ONLY threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (id);

CREATE INDEX agent_runs_start_due ON agent_runs USING btree (node_id, command_next_at, id) WHERE ((state = 'starting'::text) AND (stop_requested_at IS NULL));

CREATE INDEX agent_runs_starting ON agent_runs USING btree (state) WHERE (state = 'starting'::text);

CREATE INDEX agent_runs_stop_due ON agent_runs USING btree (node_id, command_next_at, id) WHERE ((stop_requested_at IS NOT NULL) AND (stop_acked_at IS NULL));

CREATE INDEX agent_runs_wake_nodes ON agent_runs USING btree (node_id, id) WHERE ((state = 'running'::text) AND (stop_requested_at IS NULL));

CREATE INDEX attention_inbox ON attention_requests USING btree (employee_id, created_at DESC, id DESC);

CREATE INDEX attention_project ON attention_requests USING btree (project_id, state);

CREATE UNIQUE INDEX attention_system_open ON attention_requests USING btree (project_id) WHERE ((source = 'system'::text) AND (state = 'open'::text));

CREATE INDEX attention_thread ON attention_requests USING btree (thread_id) WHERE (thread_id IS NOT NULL);

CREATE UNIQUE INDEX conversation_tool_result_once ON conversation_events USING btree (conversation_id, tool_call_id) WHERE (kind = 'tool_result'::text);

CREATE UNIQUE INDEX employees_external_subject_unique ON employees USING btree (auth_source, external_subject) WHERE (external_subject IS NOT NULL);

CREATE INDEX login_sessions_employee_id ON login_sessions USING btree (employee_id);

CREATE INDEX node_enrollments_employee_id ON node_enrollments USING btree (employee_id);

CREATE INDEX node_revocations_node_id ON node_revocations USING btree (node_id);

CREATE INDEX node_revocations_pending ON node_revocations USING btree (requested_at) WHERE (applied_at IS NULL);

CREATE INDEX nodes_employee_seq ON nodes USING btree (employee_id, registration_seq) WHERE (revoked_at IS NULL);

CREATE INDEX project_agent_pending_inputs ON project_agent_input_queue USING btree (agent_id, id) WHERE (delivered_seq IS NULL);

CREATE INDEX project_inputs_wake_due ON project_agent_input_queue USING btree (agent_id, wake_next_at, id) WHERE ((delivered_seq IS NULL) AND wake_required);

CREATE INDEX project_memory_project ON project_memory_entries USING btree (employee_id, project_id, id);

CREATE INDEX thread_events_timeline ON thread_events USING btree (employee_id, thread_id, id);

CREATE UNIQUE INDEX thread_one_active_turn ON thread_turns USING btree (thread_id) WHERE (ended_at IS NULL);

CREATE INDEX thread_outbox_node_due ON thread_outbox USING btree (node_id, next_attempt_at, id) WHERE (acked_at IS NULL);

CREATE INDEX thread_outbox_order ON thread_outbox USING btree (thread_id, id) WHERE (acked_at IS NULL);

CREATE INDEX threads_activity ON threads USING btree (employee_id, last_activity_at DESC, id DESC);

CREATE INDEX threads_project ON threads USING btree (employee_id, project_id, last_activity_at DESC, id DESC);

CREATE TRIGGER conversation_events_append_only BEFORE DELETE OR UPDATE ON conversation_events FOR EACH ROW EXECUTE FUNCTION reject_project_history_mutation();

CREATE TRIGGER project_memory_revisions_append_only BEFORE DELETE OR UPDATE ON project_memory_revisions FOR EACH ROW EXECUTE FUNCTION reject_project_history_mutation();

CREATE TRIGGER thread_events_append_only BEFORE DELETE OR UPDATE ON thread_events FOR EACH ROW EXECUTE FUNCTION reject_project_history_mutation();

ALTER TABLE ONLY agent_runs
    ADD CONSTRAINT agent_runs_employee_id_agent_id_fkey FOREIGN KEY (employee_id, agent_id) REFERENCES project_agents(employee_id, id);

ALTER TABLE ONLY agent_runs
    ADD CONSTRAINT agent_runs_employee_id_node_id_fkey FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id);

ALTER TABLE ONLY attention_requests
    ADD CONSTRAINT attention_requests_employee_id_agent_id_fkey FOREIGN KEY (employee_id, agent_id) REFERENCES project_agents(employee_id, id);

ALTER TABLE ONLY attention_requests
    ADD CONSTRAINT attention_requests_employee_id_conversation_id_fkey FOREIGN KEY (employee_id, conversation_id) REFERENCES conversations(employee_id, id);

ALTER TABLE ONLY attention_requests
    ADD CONSTRAINT attention_requests_employee_id_project_id_fkey FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id);

ALTER TABLE ONLY attention_requests
    ADD CONSTRAINT attention_requests_employee_id_thread_id_fkey FOREIGN KEY (employee_id, thread_id) REFERENCES threads(employee_id, id);

ALTER TABLE ONLY conversation_events
    ADD CONSTRAINT conversation_events_employee_id_conversation_id_fkey FOREIGN KEY (employee_id, conversation_id) REFERENCES conversations(employee_id, id);

ALTER TABLE ONLY conversations
    ADD CONSTRAINT conversations_employee_id_agent_id_fkey FOREIGN KEY (employee_id, agent_id) REFERENCES project_agents(employee_id, id);

ALTER TABLE ONLY employee_settings
    ADD CONSTRAINT employee_settings_default_node_fk FOREIGN KEY (employee_id, default_device_node_id) REFERENCES nodes(employee_id, id);

ALTER TABLE ONLY employee_settings
    ADD CONSTRAINT employee_settings_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id);

ALTER TABLE ONLY login_sessions
    ADD CONSTRAINT login_sessions_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id);

ALTER TABLE ONLY node_credentials
    ADD CONSTRAINT node_credentials_node_fk FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id);

ALTER TABLE ONLY node_enrollments
    ADD CONSTRAINT node_enrollments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id);

ALTER TABLE ONLY node_presence
    ADD CONSTRAINT node_presence_node_fk FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id);

ALTER TABLE ONLY node_presence
    ADD CONSTRAINT node_presence_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id);

ALTER TABLE ONLY node_revocations
    ADD CONSTRAINT node_revocations_actor_employee_id_fkey FOREIGN KEY (actor_employee_id) REFERENCES employees(id);

ALTER TABLE ONLY node_revocations
    ADD CONSTRAINT node_revocations_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES node_credentials(id);

ALTER TABLE ONLY node_revocations
    ADD CONSTRAINT node_revocations_node_fk FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id);

ALTER TABLE ONLY node_runtime_reports
    ADD CONSTRAINT node_runtime_reports_node_fk FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id);

ALTER TABLE ONLY nodes
    ADD CONSTRAINT nodes_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id);

ALTER TABLE ONLY project_agent_input_queue
    ADD CONSTRAINT project_agent_input_queue_employee_id_agent_id_fkey FOREIGN KEY (employee_id, agent_id) REFERENCES project_agents(employee_id, id);

ALTER TABLE ONLY project_agents
    ADD CONSTRAINT project_agents_employee_id_project_id_fkey FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id);

ALTER TABLE ONLY project_memory_entries
    ADD CONSTRAINT project_memory_current_revision_fk FOREIGN KEY (id, current_revision) REFERENCES project_memory_revisions(entry_id, revision) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY project_memory_entries
    ADD CONSTRAINT project_memory_entries_employee_id_project_id_fkey FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id);

ALTER TABLE ONLY project_memory_revisions
    ADD CONSTRAINT project_memory_revisions_employee_id_entry_id_fkey FOREIGN KEY (employee_id, entry_id) REFERENCES project_memory_entries(employee_id, id);

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id);

ALTER TABLE ONLY thread_events
    ADD CONSTRAINT thread_events_employee_id_thread_id_fkey FOREIGN KEY (employee_id, thread_id) REFERENCES threads(employee_id, id);

ALTER TABLE ONLY thread_messages
    ADD CONSTRAINT thread_messages_employee_id_thread_id_fkey FOREIGN KEY (employee_id, thread_id) REFERENCES threads(employee_id, id);

ALTER TABLE ONLY thread_messages
    ADD CONSTRAINT thread_messages_employee_id_thread_id_turn_id_worker_turn__fkey FOREIGN KEY (employee_id, thread_id, turn_id, worker_turn_seq) REFERENCES thread_turns(employee_id, thread_id, id, worker_turn_seq);

ALTER TABLE ONLY thread_outbox
    ADD CONSTRAINT thread_outbox_employee_id_thread_id_node_id_fkey FOREIGN KEY (employee_id, thread_id, node_id) REFERENCES threads(employee_id, id, node_id);

ALTER TABLE ONLY thread_replies
    ADD CONSTRAINT thread_replies_employee_id_thread_id_fkey FOREIGN KEY (employee_id, thread_id) REFERENCES threads(employee_id, id);

ALTER TABLE ONLY thread_replies
    ADD CONSTRAINT thread_replies_employee_id_thread_id_turn_id_worker_turn_s_fkey FOREIGN KEY (employee_id, thread_id, turn_id, worker_turn_seq) REFERENCES thread_turns(employee_id, thread_id, id, worker_turn_seq);

ALTER TABLE ONLY thread_reports
    ADD CONSTRAINT thread_reports_employee_id_thread_id_fkey FOREIGN KEY (employee_id, thread_id) REFERENCES threads(employee_id, id);

ALTER TABLE ONLY thread_turns
    ADD CONSTRAINT thread_turns_employee_id_thread_id_fkey FOREIGN KEY (employee_id, thread_id) REFERENCES threads(employee_id, id);

ALTER TABLE ONLY threads
    ADD CONSTRAINT threads_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id);

ALTER TABLE ONLY threads
    ADD CONSTRAINT threads_employee_id_node_id_fkey FOREIGN KEY (employee_id, node_id) REFERENCES nodes(employee_id, id);

ALTER TABLE ONLY threads
    ADD CONSTRAINT threads_employee_id_origin_conversation_id_fkey FOREIGN KEY (employee_id, origin_conversation_id) REFERENCES conversations(employee_id, id);

ALTER TABLE ONLY threads
    ADD CONSTRAINT threads_employee_id_project_id_fkey FOREIGN KEY (employee_id, project_id) REFERENCES projects(employee_id, id);
