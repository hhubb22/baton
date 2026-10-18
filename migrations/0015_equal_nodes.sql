DROP INDEX nodes_employee_pc_seq;
ALTER TABLE nodes DROP CONSTRAINT nodes_role_name;
ALTER TABLE nodes DROP COLUMN role;
CREATE INDEX nodes_employee_seq
    ON nodes (employee_id, registration_seq)
    WHERE revoked_at IS NULL;

ALTER TABLE employee_settings RENAME COLUMN default_pc_node_id TO default_device_node_id;

INSERT INTO employee_settings (employee_id, default_device_node_id, updated_at)
SELECT DISTINCT ON (employee_id) employee_id, id, now()
FROM nodes
WHERE revoked_at IS NULL
ORDER BY employee_id, registration_seq
ON CONFLICT (employee_id) DO UPDATE
SET default_device_node_id = EXCLUDED.default_device_node_id, updated_at = now()
WHERE employee_settings.default_device_node_id IS NULL;

CREATE TABLE node_runtime_reports (
    node_id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    report_version bigint NOT NULL,
    reported_at timestamptz NOT NULL,
    report jsonb NOT NULL,
    CONSTRAINT node_runtime_reports_node_fk
        FOREIGN KEY (employee_id, node_id) REFERENCES nodes (employee_id, id),
    CONSTRAINT node_runtime_reports_version_positive CHECK (report_version > 0),
    CONSTRAINT node_runtime_reports_size CHECK (octet_length(report::text) <= 65536)
);
