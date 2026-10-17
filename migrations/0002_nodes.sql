CREATE SEQUENCE node_registration_seq AS bigint INCREMENT BY 1 MINVALUE 1 START WITH 1 NO CYCLE;

CREATE TABLE nodes (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees (id),
    display_name text NOT NULL,
    system_name text NOT NULL,
    role text NOT NULL,
    capabilities text[] NOT NULL,
    registration_seq bigint NOT NULL,
    registered_at timestamptz NOT NULL,
    credential_version integer NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT nodes_employee_node_unique UNIQUE (employee_id, id),
    CONSTRAINT nodes_registration_seq_unique UNIQUE (registration_seq),
    CONSTRAINT nodes_registration_seq_positive CHECK (registration_seq > 0),
    CONSTRAINT nodes_credential_version_positive CHECK (credential_version >= 1),
    CONSTRAINT nodes_system_name CHECK (system_name IN ('windows', 'macos', 'linux')),
    CONSTRAINT nodes_role_name CHECK (role IN ('pc', 'ubuntu')),
    CONSTRAINT nodes_capabilities_count CHECK (cardinality(capabilities) <= 32),
    CONSTRAINT nodes_display_name_text CHECK (
        char_length(display_name) BETWEEN 1 AND 80
        AND display_name !~ '[[:cntrl:]]'
    )
);

CREATE INDEX nodes_employee_pc_seq
    ON nodes (employee_id, registration_seq)
    WHERE role = 'pc' AND revoked_at IS NULL;

CREATE TABLE node_credentials (
    id uuid PRIMARY KEY,
    node_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    version integer NOT NULL,
    token_hash bytea NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT node_credentials_node_fk
        FOREIGN KEY (employee_id, node_id) REFERENCES nodes (employee_id, id),
    CONSTRAINT node_credentials_node_version_unique UNIQUE (node_id, version),
    CONSTRAINT node_credentials_token_hash_unique UNIQUE (token_hash),
    CONSTRAINT node_credentials_version_positive CHECK (version >= 1),
    CONSTRAINT node_credentials_hash_length CHECK (octet_length(token_hash) = 32),
    CONSTRAINT node_credentials_expires_after_create CHECK (expires_at > created_at)
);

CREATE TABLE node_enrollments (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees (id),
    token_hash bytea NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    CONSTRAINT node_enrollments_token_hash_unique UNIQUE (token_hash),
    CONSTRAINT node_enrollments_hash_length CHECK (octet_length(token_hash) = 32),
    CONSTRAINT node_enrollments_expires_after_create CHECK (expires_at > created_at)
);

CREATE INDEX node_enrollments_employee_id ON node_enrollments (employee_id);

CREATE TABLE employee_settings (
    employee_id uuid PRIMARY KEY REFERENCES employees (id),
    default_pc_node_id uuid,
    updated_at timestamptz NOT NULL,
    CONSTRAINT employee_settings_default_node_fk
        FOREIGN KEY (employee_id, default_pc_node_id) REFERENCES nodes (employee_id, id)
);
