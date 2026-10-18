-- 扩展现有事件种类，保留先行迁移添加的约束分支。
DO $$
DECLARE previous_expression text;
BEGIN
    SELECT pg_get_expr(conbin, conrelid) INTO previous_expression
    FROM pg_constraint
    WHERE conrelid = 'task_events'::regclass AND conname = 'task_events_kind_name';
    ALTER TABLE task_events DROP CONSTRAINT task_events_kind_name;
    EXECUTE format('ALTER TABLE task_events ADD CONSTRAINT task_events_kind_name CHECK ((%s) OR kind IN (''resolved'', ''rerun_requested''))', previous_expression);
END $$;

ALTER TABLE task_events
    ADD COLUMN resolution jsonb,
    ADD COLUMN rerun jsonb,
    ADD CONSTRAINT task_events_resolution_kind CHECK ((kind = 'resolved') = (resolution IS NOT NULL)),
    ADD CONSTRAINT task_events_rerun_kind CHECK ((kind = 'rerun_requested') = (rerun IS NOT NULL));

ALTER TABLE task_relations
    ADD COLUMN rerun_of_task_id uuid,
    ADD CONSTRAINT task_relations_rerun_fk FOREIGN KEY (employee_id, rerun_of_task_id)
        REFERENCES tasks (employee_id, id),
    ADD CONSTRAINT task_relations_rerun_distinct CHECK (rerun_of_task_id <> task_id);
CREATE INDEX task_relations_rerun ON task_relations (employee_id, rerun_of_task_id)
    WHERE rerun_of_task_id IS NOT NULL;
