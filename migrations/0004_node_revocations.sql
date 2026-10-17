CREATE TABLE node_revocations (
    id uuid PRIMARY KEY,
    node_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    actor_employee_id uuid NOT NULL REFERENCES employees (id),
    credential_id uuid NOT NULL REFERENCES node_credentials (id),
    requested_at timestamptz NOT NULL,
    applied_at timestamptz,
    CONSTRAINT node_revocations_node_fk
        FOREIGN KEY (employee_id, node_id) REFERENCES nodes (employee_id, id),
    CONSTRAINT node_revocations_credential_unique UNIQUE (credential_id),
    CONSTRAINT node_revocations_applied_after
        CHECK (applied_at IS NULL OR applied_at >= requested_at)
);

CREATE INDEX node_revocations_node_id ON node_revocations (node_id);

CREATE INDEX node_revocations_pending
    ON node_revocations (requested_at)
    WHERE applied_at IS NULL;
