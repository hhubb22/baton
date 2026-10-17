ALTER TABLE node_credentials DROP CONSTRAINT node_credentials_token_hash_unique;
ALTER TABLE node_credentials DROP CONSTRAINT node_credentials_hash_length;
ALTER TABLE node_credentials DROP COLUMN token_hash;

CREATE TABLE node_presence (
    node_id uuid PRIMARY KEY REFERENCES nodes (id),
    employee_id uuid NOT NULL,
    online boolean NOT NULL,
    synced boolean NOT NULL,
    incarnation text NOT NULL,
    conn_id text NOT NULL,
    last_contact_at timestamptz,
    status_updated_at timestamptz NOT NULL,
    CONSTRAINT node_presence_node_fk
        FOREIGN KEY (employee_id, node_id) REFERENCES nodes (employee_id, id),
    CONSTRAINT node_presence_incarnation_len CHECK (char_length(incarnation) BETWEEN 1 AND 80),
    CONSTRAINT node_presence_conn_len CHECK (char_length(conn_id) BETWEEN 1 AND 80)
);
