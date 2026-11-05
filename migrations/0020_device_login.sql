ALTER TABLE node_credentials ALTER COLUMN expires_at DROP NOT NULL;
UPDATE node_credentials SET expires_at=NULL;

CREATE TABLE device_login_sessions (
  id uuid PRIMARY KEY,
  device_code_hash bytea NOT NULL UNIQUE CHECK (octet_length(device_code_hash)=32),
  user_code text NOT NULL CHECK (user_code ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80 AND display_name !~ '[[:cntrl:]]'),
  system text NOT NULL CHECK (system IN ('macos','linux','windows')),
  status text NOT NULL CHECK (status IN ('pending','approved','consumed','denied','expired')),
  employee_id uuid REFERENCES employees(id),
  node_id uuid,
  credential_id uuid REFERENCES node_credentials(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>created_at),
  consumed_at timestamptz,
  FOREIGN KEY (employee_id,node_id) REFERENCES nodes(employee_id,id),
  CHECK (status NOT IN ('approved','consumed') OR
    (employee_id IS NOT NULL AND node_id IS NOT NULL AND credential_id IS NOT NULL)),
  CHECK (status<>'pending' OR (employee_id IS NULL AND node_id IS NULL AND credential_id IS NULL)),
  CHECK (status<>'consumed' OR consumed_at IS NOT NULL)
);

CREATE UNIQUE INDEX device_login_pending_user_code ON device_login_sessions(user_code) WHERE status='pending';
CREATE INDEX device_login_user_code ON device_login_sessions(user_code,created_at DESC);
