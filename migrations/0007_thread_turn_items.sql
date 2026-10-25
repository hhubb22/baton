ALTER TABLE thread_turns ADD COLUMN token_usage json;

CREATE TABLE thread_turn_items (
    employee_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    worker_turn_seq bigint NOT NULL CHECK (worker_turn_seq > 0),
    item_id text NOT NULL,
    worker_seq bigint NOT NULL CHECK (worker_seq > 0),
    ordinal bigint NOT NULL CHECK (ordinal >= 0),
    parent_id text,
    type text NOT NULL,
    status text NOT NULL,
    title text,
    started_at timestamptz,
    completed_at timestamptz,
    data json NOT NULL CHECK (octet_length(data::text) <= 196608),
    truncated boolean NOT NULL,
    original_bytes bigint NOT NULL CHECK (original_bytes >= 0),
    full_output json,
    PRIMARY KEY (employee_id, thread_id, worker_turn_seq, item_id),
    UNIQUE (employee_id, thread_id, worker_seq),
    FOREIGN KEY (employee_id, thread_id, worker_turn_seq)
        REFERENCES thread_turns(employee_id, thread_id, worker_turn_seq)
);

CREATE INDEX thread_turn_items_order
    ON thread_turn_items (employee_id, thread_id, worker_turn_seq, ordinal, worker_seq);
