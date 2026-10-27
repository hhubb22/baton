ALTER TABLE threads ADD COLUMN stop_code text
    CHECK (stop_code IN ('user_stopped', 'forced_stop', 'interrupted', 'history_lost', 'folder_missing', 'start_failed'));

UPDATE threads t
SET stop_code = CASE
    WHEN t.status_reason ~* 'history_missing|history_lost|native Agent history missing|对话记录.*(丢失|不存在)|历史.*(丢失|找不到)'
        OR (last_event.payload->>'history_unavailable' = 'true'
            AND COALESCE(last_event.payload->>'reason', '') = t.status_reason)
        THEN 'history_lost'
    WHEN t.status_reason ~* 'folder_missing|working_directory_missing|目录.*(不存在|找不到)|找不到.*目录'
        THEN 'folder_missing'
    WHEN t.status_reason ~* 'forced|没有在 1 分钟内停下' THEN 'forced_stop'
    WHEN t.stop_confirmed_at IS NOT NULL THEN 'user_stopped'
    WHEN t.opened_at IS NULL THEN 'start_failed'
    ELSE 'interrupted'
END
FROM threads old
LEFT JOIN LATERAL (
    SELECT e.payload FROM thread_events e
    WHERE e.employee_id = old.employee_id AND e.thread_id = old.id
        AND e.kind IN ('status.changed', 'thread.stopped', 'thread.unknown', 'thread.open_failed', 'message.unknown')
    ORDER BY e.id DESC LIMIT 1
) last_event ON true
WHERE t.id = old.id AND t.status IN ('stopped', 'unknown');
