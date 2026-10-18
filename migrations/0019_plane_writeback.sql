-- 员工验收单独保存，不改变执行结论或生成新的执行。
CREATE TABLE task_acceptances (
    id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    task_id uuid NOT NULL,
    task_version integer NOT NULL CHECK (task_version > 0),
    decision text NOT NULL CHECK (decision IN ('passed', 'rejected')),
    comment text NOT NULL CHECK (char_length(comment) BETWEEN 1 AND 400),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (employee_id, task_id) REFERENCES tasks (employee_id, id),
    UNIQUE (task_id, task_version)
);

CREATE TABLE plane_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trigger_id text NOT NULL REFERENCES plane_triggers (trigger_id),
    task_id uuid NOT NULL REFERENCES tasks (id),
    task_version integer NOT NULL CHECK (task_version > 0),
    snapshot jsonb NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    lease_id uuid,
    last_error_code text NOT NULL DEFAULT '',
    comment_id uuid,
    delivered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (trigger_id, task_version)
);
CREATE INDEX plane_triggers_task ON plane_triggers (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX plane_outbox_pending ON plane_outbox (next_attempt_at) WHERE delivered_at IS NULL;

-- 延迟到事务结束后读取摘要和引用，保证快照包含同一事务的全部结果。
CREATE FUNCTION plane_snapshot_task(task_uuid uuid) RETURNS void LANGUAGE sql AS $$
    INSERT INTO plane_outbox (trigger_id, task_id, task_version, snapshot)
    SELECT p.trigger_id, t.id, t.version,
        jsonb_build_object('status', t.status, 'summary', COALESCE(t.summary, ''),
            'error_code', COALESCE(t.error_code, ''),
            'start_authorized', EXISTS(SELECT 1 FROM executions e WHERE e.task_id=t.id AND e.start_authorized_at IS NOT NULL),
            'evidence', COALESCE((SELECT jsonb_agg(jsonb_build_object('position', r.position,
                'access_status', r.access_status) ORDER BY r.position)
                FROM task_result_refs r WHERE r.task_id=t.id AND r.kind='evidence'), '[]'::jsonb),
            'acceptance', (SELECT jsonb_build_object('decision', a.decision, 'comment', a.comment,
                'employee_id', a.employee_id, 'created_at', a.created_at, 'task_version', a.task_version)
                FROM task_acceptances a WHERE a.task_id=t.id AND a.task_version<=t.version
                    AND NOT EXISTS(SELECT 1 FROM task_events ev WHERE ev.task_id=t.id
                        AND ev.kind='resolved' AND ev.version>a.task_version)
                ORDER BY a.task_version DESC LIMIT 1))
    FROM tasks t JOIN plane_triggers p ON p.task_id=t.id AND p.employee_id=t.employee_id
    WHERE t.id=task_uuid
    ON CONFLICT (trigger_id, task_version) DO NOTHING;
$$;
CREATE FUNCTION plane_task_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM plane_snapshot_task(NEW.id);
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER plane_task_writeback AFTER INSERT OR UPDATE ON tasks
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION plane_task_changed();

CREATE FUNCTION plane_task_linked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.task_id IS NOT NULL THEN
        -- 与并行任务变更串行，关联提交后不能遗漏已经提交的结果。
        PERFORM 1 FROM tasks WHERE id=NEW.task_id FOR UPDATE;
        PERFORM plane_snapshot_task(NEW.task_id);
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER plane_link_writeback AFTER INSERT OR UPDATE ON plane_triggers
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION plane_task_linked();

-- 已关联任务从当前版本开始回写。
SELECT plane_snapshot_task(task_id) FROM plane_triggers WHERE task_id IS NOT NULL;
