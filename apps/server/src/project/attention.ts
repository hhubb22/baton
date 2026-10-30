import type * as SqlClient from 'effect/sql/SqlClient'

export const activeInputSQL = (sql: SqlClient.SqlClient) =>
  sql`('user_message','turn_ended','thread_message_failed','execution.finished')`

export const recoveryWorkSQL = (sql: SqlClient.SqlClient) => sql`(
 EXISTS(SELECT 1 FROM project_agent_input_queue q WHERE q.agent_id=a.id AND delivered_seq IS NULL AND source_type IN ${activeInputSQL(sql)})
 OR EXISTS(SELECT 1 FROM conversation_events e WHERE e.conversation_id=c.id
 AND e.seq=(SELECT max(t.seq) FROM conversation_events t WHERE t.conversation_id=c.id AND t.kind<>'compaction')
 AND (e.kind IN ('input','tool_result') OR (e.kind='assistant' AND jsonb_path_exists(e.payload,'$.message.content[*] ? (@.type == "toolCall")')))))`

export const projectAttentionSQL = (sql: SqlClient.SqlClient) => sql`CASE
 WHEN p.status<>'active' THEN NULL
 WHEN c.failure_count>=3 THEN 'failing'
 ELSE NULL END`

export const latestReplySeqSQL = (sql: SqlClient.SqlClient) => sql`COALESCE((
 SELECT max(e.seq) FROM conversation_events e WHERE e.conversation_id=c.id AND e.kind='assistant'
 AND jsonb_path_exists(e.payload,'$.message.content[*] ? (@.type == "text" && @.text != "")')
 AND NOT jsonb_path_exists(e.payload,'$.message.content[*] ? (@.type == "toolCall")')
),0)`
