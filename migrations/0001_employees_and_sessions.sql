CREATE TABLE employees (
    id uuid PRIMARY KEY,
    username text NOT NULL,
    display_name text NOT NULL,
    auth_source text NOT NULL,
    external_subject text,
    password_hash text,
    must_change_password boolean NOT NULL,
    password_changed_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT employees_username_unique UNIQUE (username),
    CONSTRAINT employees_username_shape CHECK (username ~ '^[a-z][a-z0-9._-]{0,62}$'),
    CONSTRAINT employees_auth_source_shape CHECK (auth_source ~ '^[a-z][a-z0-9._-]{0,62}$'),
    CONSTRAINT employees_display_name_text CHECK (
        char_length(display_name) BETWEEN 1 AND 80
        AND display_name !~ '[[:cntrl:]]'
    ),
    CONSTRAINT employees_secret_shape CHECK (
        (
            auth_source = 'local'
            AND password_hash LIKE '$argon2id$%'
            AND external_subject IS NULL
        )
        OR (
            auth_source <> 'local'
            AND password_hash IS NULL
            AND external_subject IS NOT NULL
        )
    )
);

CREATE UNIQUE INDEX employees_external_subject_unique
    ON employees (auth_source, external_subject)
    WHERE external_subject IS NOT NULL;

CREATE TABLE login_sessions (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees (id),
    token_hash bytea NOT NULL,
    csrf_hash bytea NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT login_sessions_token_hash_unique UNIQUE (token_hash),
    CONSTRAINT login_sessions_hash_length CHECK (
        octet_length(token_hash) = 32
        AND octet_length(csrf_hash) = 32
    )
);

CREATE INDEX login_sessions_employee_id ON login_sessions (employee_id);
