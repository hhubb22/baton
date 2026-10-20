ALTER TABLE agent_runs
    ADD COLUMN stop_requested_at timestamptz,
    ADD COLUMN command_next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN command_attempts integer NOT NULL DEFAULT 0 CHECK (command_attempts >= 0);

UPDATE agent_runs SET command_next_at=started_at WHERE state='starting';
UPDATE agent_runs SET stop_requested_at=COALESCE(ended_at,clock_timestamp()),
    command_next_at=clock_timestamp()+random()*interval '30 seconds'
    WHERE state IN ('finished','lost','failed') AND stop_acked_at IS NULL;

CREATE INDEX agent_runs_start_due ON agent_runs(node_id,command_next_at,id)
    WHERE state='starting' AND stop_requested_at IS NULL;
CREATE INDEX agent_runs_stop_due ON agent_runs(node_id,command_next_at,id)
    WHERE stop_requested_at IS NOT NULL AND stop_acked_at IS NULL;
CREATE INDEX agent_runs_wake_nodes ON agent_runs(node_id,id)
    WHERE state='running' AND stop_requested_at IS NULL;

ALTER TABLE project_agent_input_queue
    ADD COLUMN wake_required boolean NOT NULL DEFAULT false,
    ADD COLUMN wake_next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN wake_attempts integer NOT NULL DEFAULT 0 CHECK (wake_attempts >= 0);
UPDATE project_agent_input_queue SET wake_required=true,wake_next_at=created_at
    WHERE delivered_seq IS NULL AND source_type IN ('user_message','task_result','attention_answer');
CREATE INDEX project_inputs_wake_due ON project_agent_input_queue(agent_id,wake_next_at,id)
    WHERE delivered_seq IS NULL AND wake_required;
