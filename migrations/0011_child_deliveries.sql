CREATE TABLE child_deliveries (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees(id),
    source_execution_id uuid NOT NULL REFERENCES executions(id),
    child_execution_id uuid NOT NULL UNIQUE REFERENCES executions(id),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available', 'delivered', 'uncertain', 'source_stopped')),
    input_generation integer CHECK (input_generation > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_execution_id, input_generation)
);
CREATE INDEX child_deliveries_source ON child_deliveries(source_execution_id);
