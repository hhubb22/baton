ALTER TABLE project_agents ADD COLUMN source_node_id uuid REFERENCES nodes(id);
