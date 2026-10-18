ALTER TABLE tasks ADD COLUMN required_artifacts jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(required_artifacts) = 'array' AND jsonb_array_length(required_artifacts) <= 32);

DO $$
DECLARE previous_expression text;
BEGIN
    SELECT pg_get_expr(conbin, conrelid) INTO previous_expression
    FROM pg_constraint
    WHERE conrelid = 'tasks'::regclass AND conname = 'tasks_error_code';
    ALTER TABLE tasks DROP CONSTRAINT tasks_error_code;
    EXECUTE format('ALTER TABLE tasks ADD CONSTRAINT tasks_error_code CHECK ((%s) OR error_code = ''artifact_unavailable'')', previous_expression);

    SELECT pg_get_expr(conbin, conrelid) INTO previous_expression
    FROM pg_constraint
    WHERE conrelid = 'task_events'::regclass AND conname = 'task_events_reason_code';
    ALTER TABLE task_events DROP CONSTRAINT task_events_reason_code;
    EXECUTE format('ALTER TABLE task_events ADD CONSTRAINT task_events_reason_code CHECK ((%s) OR reason_code = ''artifact_unavailable'')', previous_expression);
END $$;
