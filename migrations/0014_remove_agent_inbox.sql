DROP TABLE attention_requests;

DELETE FROM project_agent_input_queue WHERE source_type = 'attention_answer';

ALTER TABLE project_agent_input_queue
    DROP CONSTRAINT project_agent_input_queue_source_type_check,
    DROP CONSTRAINT project_input_source_size,
    ADD CONSTRAINT project_agent_input_queue_source_type_check CHECK (
        source_type IN ('user_message', 'memory_updated', 'project_updated', 'thread_reply', 'turn_ended', 'thread_message_failed')
    ),
    ADD CONSTRAINT project_input_source_size CHECK (
        (source_type NOT IN ('thread_reply', 'thread_message_failed') OR octet_length(payload::text) <= 40960)
        AND (source_type <> 'turn_ended' OR octet_length(payload::text) <= CASE WHEN payload ? 'command_result' THEN 73728 ELSE 4096 END)
        AND (source_type <> 'memory_updated' OR octet_length(payload::text) <= 1024)
        AND (source_type <> 'project_updated' OR octet_length(payload::text) <= 4096)
    );
