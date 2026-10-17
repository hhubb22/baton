ALTER TABLE nodes
    ADD COLUMN default_agent_type text,
    ADD CONSTRAINT nodes_default_agent_type_shape CHECK (
        default_agent_type IS NULL
        OR default_agent_type ~ '^[a-z][a-z0-9._-]{0,63}$'
    );

CREATE TABLE tasks (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees (id),
    request_id text NOT NULL,
    request_hash bytea NOT NULL,
    description text NOT NULL,
    source_session_id uuid,
    parent_task_id uuid,
    target_session_id uuid,
    working_directory text,
    device_names text[],
    authorization_scope text,
    expected_outputs text,
    requested_target_node_id uuid,
    requested_agent_type text,
    requested_queue_timeout_seconds integer,
    requested_execution_timeout_seconds integer,
    target_node_id uuid NOT NULL,
    agent_type text NOT NULL,
    queue_timeout_seconds integer NOT NULL,
    execution_timeout_seconds integer NOT NULL,
    queue_expires_at timestamptz NOT NULL,
    status text NOT NULL,
    version integer NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT tasks_employee_task_unique UNIQUE (employee_id, id),
    CONSTRAINT tasks_employee_request_unique UNIQUE (employee_id, request_id),
    CONSTRAINT tasks_parent_fk
        FOREIGN KEY (employee_id, parent_task_id) REFERENCES tasks (employee_id, id),
    CONSTRAINT tasks_target_node_fk
        FOREIGN KEY (employee_id, target_node_id) REFERENCES nodes (employee_id, id),
    CONSTRAINT tasks_requested_node_fk
        FOREIGN KEY (employee_id, requested_target_node_id) REFERENCES nodes (employee_id, id),
    CONSTRAINT tasks_parent_not_self CHECK (parent_task_id IS NULL OR parent_task_id <> id),
    CONSTRAINT tasks_request_id_text CHECK (
        char_length(request_id) BETWEEN 1 AND 200
        AND request_id !~ '[[:cntrl:]]'
    ),
    CONSTRAINT tasks_request_hash_length CHECK (octet_length(request_hash) = 32),
    CONSTRAINT tasks_description_text CHECK (
        char_length(description) BETWEEN 1 AND 32768
        AND description !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]'
    ),
    CONSTRAINT tasks_working_directory_text CHECK (
        working_directory IS NULL
        OR (
            char_length(working_directory) BETWEEN 1 AND 1024
            AND working_directory !~ '[[:cntrl:]]'
        )
    ),
    CONSTRAINT tasks_authorization_scope_text CHECK (
        authorization_scope IS NULL
        OR (
            char_length(authorization_scope) BETWEEN 1 AND 32768
            AND authorization_scope !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]'
        )
    ),
    CONSTRAINT tasks_expected_outputs_text CHECK (
        expected_outputs IS NULL
        OR (
            char_length(expected_outputs) BETWEEN 1 AND 32768
            AND expected_outputs !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]'
        )
    ),
    CONSTRAINT tasks_device_names_count CHECK (
        device_names IS NULL OR cardinality(device_names) <= 32
    ),
    CONSTRAINT tasks_agent_type_shape CHECK (agent_type ~ '^[a-z][a-z0-9._-]{0,63}$'),
    CONSTRAINT tasks_requested_agent_type_shape CHECK (
        requested_agent_type IS NULL
        OR requested_agent_type ~ '^[a-z][a-z0-9._-]{0,63}$'
    ),
    CONSTRAINT tasks_queue_timeout_positive CHECK (queue_timeout_seconds > 0),
    CONSTRAINT tasks_execution_timeout_positive CHECK (execution_timeout_seconds > 0),
    CONSTRAINT tasks_requested_queue_timeout_positive CHECK (
        requested_queue_timeout_seconds IS NULL OR requested_queue_timeout_seconds > 0
    ),
    CONSTRAINT tasks_requested_execution_timeout_positive CHECK (
        requested_execution_timeout_seconds IS NULL OR requested_execution_timeout_seconds > 0
    ),
    CONSTRAINT tasks_queue_deadline CHECK (queue_expires_at > created_at),
    CONSTRAINT tasks_version_positive CHECK (version >= 1),
    CONSTRAINT tasks_status_name CHECK (
        status IN ('queued', 'running', 'needs_verification', 'completed', 'failed', 'cancelled')
    )
);

CREATE INDEX tasks_employee_created ON tasks (employee_id, created_at DESC, id DESC);

CREATE INDEX tasks_parent
    ON tasks (employee_id, parent_task_id)
    WHERE parent_task_id IS NOT NULL;

CREATE TABLE executions (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    target_node_id uuid NOT NULL,
    storage_generation text,
    prepared_at timestamptz,
    start_authorized_at timestamptz,
    created_at timestamptz NOT NULL,
    CONSTRAINT executions_task_unique UNIQUE (task_id),
    CONSTRAINT executions_task_fk
        FOREIGN KEY (employee_id, task_id) REFERENCES tasks (employee_id, id),
    CONSTRAINT executions_node_fk
        FOREIGN KEY (employee_id, target_node_id) REFERENCES nodes (employee_id, id)
);

CREATE TABLE task_events (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    version integer NOT NULL,
    actor_employee_id uuid NOT NULL REFERENCES employees (id),
    kind text NOT NULL,
    status text NOT NULL,
    target_node_id uuid NOT NULL,
    agent_type text NOT NULL,
    queue_expires_at timestamptz NOT NULL,
    execution_timeout_seconds integer NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT task_events_task_version_unique UNIQUE (task_id, version),
    CONSTRAINT task_events_task_fk
        FOREIGN KEY (employee_id, task_id) REFERENCES tasks (employee_id, id),
    CONSTRAINT task_events_version_positive CHECK (version >= 1),
    CONSTRAINT task_events_kind_name CHECK (kind = 'accepted'),
    CONSTRAINT task_events_status_name CHECK (
        status IN ('queued', 'running', 'needs_verification', 'completed', 'failed', 'cancelled')
    ),
    CONSTRAINT task_events_agent_type_shape CHECK (agent_type ~ '^[a-z][a-z0-9._-]{0,63}$'),
    CONSTRAINT task_events_execution_timeout_positive CHECK (execution_timeout_seconds > 0)
);

CREATE TABLE dispatch_outbox (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    task_id uuid NOT NULL,
    execution_id uuid NOT NULL REFERENCES executions (id),
    target_node_id uuid NOT NULL,
    action text NOT NULL,
    send_deadline timestamptz NOT NULL,
    lease_until timestamptz,
    created_at timestamptz NOT NULL,
    CONSTRAINT dispatch_outbox_task_action_unique UNIQUE (task_id, action),
    CONSTRAINT dispatch_outbox_task_fk
        FOREIGN KEY (employee_id, task_id) REFERENCES tasks (employee_id, id),
    CONSTRAINT dispatch_outbox_node_fk
        FOREIGN KEY (employee_id, target_node_id) REFERENCES nodes (employee_id, id),
    CONSTRAINT dispatch_outbox_action_name CHECK (action = 'prepare')
);

CREATE TABLE request_tombstones (
    employee_id uuid NOT NULL REFERENCES employees (id),
    request_id text NOT NULL,
    request_hash bytea NOT NULL,
    task_id uuid NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT request_tombstones_pk PRIMARY KEY (employee_id, request_id),
    CONSTRAINT request_tombstones_hash_length CHECK (octet_length(request_hash) = 32),
    CONSTRAINT request_tombstones_request_id_text CHECK (
        char_length(request_id) BETWEEN 1 AND 200
        AND request_id !~ '[[:cntrl:]]'
    )
);
