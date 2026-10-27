CREATE SEQUENCE thread_activity_check_seq;
SELECT setval('thread_activity_check_seq', GREATEST(COALESCE((SELECT max(id) FROM thread_events), 0), 1));

CREATE TABLE thread_activity_probes (
    thread_id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    checks jsonb NOT NULL DEFAULT '{}',
    acknowledged_seq bigint NOT NULL DEFAULT 0,
    FOREIGN KEY (employee_id, thread_id) REFERENCES threads(employee_id, id)
);

-- 保留有效期内的 challenge，使迁移前发出的回执仍可验证。
INSERT INTO thread_activity_probes(thread_id, employee_id, checks, acknowledged_seq)
SELECT e.thread_id, e.employee_id,
    COALESCE(jsonb_object_agg(e.id::text,
        e.payload || jsonb_build_object('issued_at', extract(epoch FROM e.created_at)) ||
        CASE WHEN a.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
            'result', a.payload, 'acknowledged_at', extract(epoch FROM a.created_at)) END
    ) FILTER (WHERE e.created_at > clock_timestamp() - interval '60 seconds'), '{}'),
    COALESCE(max(e.id) FILTER (WHERE a.id IS NOT NULL), 0)
FROM thread_events e
LEFT JOIN thread_events a ON a.thread_id = e.thread_id AND a.kind = 'turn.activity_checked'
    AND (a.payload->>'activity_check_seq')::bigint = e.id
WHERE e.kind = 'turn.activity_check'
GROUP BY e.thread_id, e.employee_id;

ALTER TABLE thread_events DISABLE TRIGGER thread_events_append_only;
DELETE FROM thread_events WHERE kind IN ('turn.activity_check', 'turn.activity_checked');
ALTER TABLE thread_events ENABLE TRIGGER thread_events_append_only;
