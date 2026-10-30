CREATE TABLE node_update_requests (
  operation_id uuid PRIMARY KEY,
  employee_id uuid NOT NULL,
  node_id uuid NOT NULL,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  phase text NOT NULL DEFAULT 'requested' CHECK (phase IN ('requested','downloading','verifying','draining','ready','migrating','syncing','completed','cancelled','failed')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  management_last_seen timestamptz,
  FOREIGN KEY (employee_id,node_id) REFERENCES nodes(employee_id,id)
);
CREATE INDEX node_update_requests_latest ON node_update_requests(node_id,created_at DESC);
CREATE UNIQUE INDEX node_update_requests_active ON node_update_requests(node_id)
  WHERE phase NOT IN ('completed','cancelled');

CREATE TABLE node_update_management (
  node_id uuid PRIMARY KEY,
  employee_id uuid NOT NULL,
  last_seen timestamptz NOT NULL DEFAULT clock_timestamp(),
  availability jsonb,
  FOREIGN KEY (employee_id,node_id) REFERENCES nodes(employee_id,id)
);
