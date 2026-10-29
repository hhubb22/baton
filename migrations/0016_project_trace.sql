ALTER TABLE project_agent_input_queue ADD COLUMN trace_context jsonb;
ALTER TABLE agent_runs ADD COLUMN trace_context jsonb;
