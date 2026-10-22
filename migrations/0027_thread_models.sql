ALTER TABLE threads ADD COLUMN model text NOT NULL DEFAULT '' CHECK (octet_length(model)<=512);
ALTER TABLE thread_messages ADD COLUMN model text NOT NULL DEFAULT '' CHECK (octet_length(model)<=512);
ALTER TABLE thread_turns ADD COLUMN model text NOT NULL DEFAULT '' CHECK (octet_length(model)<=512);
ALTER TABLE thread_reports ADD COLUMN payload_hash_version smallint NOT NULL DEFAULT 1 CHECK (payload_hash_version IN (1,2));
ALTER TABLE thread_messages ADD COLUMN status_reason text NOT NULL DEFAULT '' CHECK (octet_length(status_reason)<=4096);

ALTER TABLE project_agent_input_queue DROP CONSTRAINT project_agent_input_queue_source_type_check;
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_agent_input_queue_source_type_check
    CHECK (source_type IN ('user_message','task_result','user_task_result','attention_answer','memory_updated','project_updated','thread_reply','turn_ended','thread_message_failed'));
ALTER TABLE project_agent_input_queue ADD CONSTRAINT project_agent_thread_message_failed_size_check
    CHECK (source_type <> 'thread_message_failed' OR octet_length(payload::text)<=40960);
