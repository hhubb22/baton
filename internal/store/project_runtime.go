package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"

	"baton/internal/identity"
	"baton/internal/inbox"
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type projectRunBinding struct {
	agentID, conversationID, projectID, owner, provider, model, prompt string
	nextSeq                                                            int64
}

func validateProjectRun(ctx context.Context, tx pgx.Tx, src protocol.Source, req protocol.ProjectRuntimeRequest) (projectRunBinding, error) {
	var b projectRunBinding
	if _, err := identity.ParseUUID(req.RunID); err != nil || req.LeaseEpoch < 1 {
		return b, projectagent.ErrLeaseLost
	}
	err := tx.QueryRow(ctx, `SELECT a.id::text FROM project_agents a JOIN agent_runs r ON r.agent_id=a.id WHERE r.id=$1 AND r.employee_id=$2 AND r.node_id=$3 FOR NO KEY UPDATE OF a`, req.RunID, src.EmployeeID, src.NodeID).Scan(&b.agentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return b, projectagent.ErrLeaseLost
	}
	if err != nil {
		return b, err
	}
	// 先取得 Agent 锁，再以数据库当前时刻检查，不能沿用等待锁之前的租约快照。
	err = tx.QueryRow(ctx, `SELECT a.employee_id::text,a.project_id::text,c.id::text,c.next_seq,r.provider,r.model,a.prompt_version
 FROM project_agents a JOIN agent_runs r ON r.id=a.lease_run_id JOIN projects p ON p.id=a.project_id JOIN conversations c ON c.agent_id=a.id
 WHERE a.id=$1 AND r.id=$2 AND a.lease_epoch=$3 AND r.lease_epoch=$3 AND a.lease_until>clock_timestamp()
 AND r.state IN ('starting','running') AND p.status='active'`, b.agentID, req.RunID, req.LeaseEpoch).
		Scan(&b.owner, &b.projectID, &b.conversationID, &b.nextSeq, &b.provider, &b.model, &b.prompt)
	if errors.Is(err, pgx.ErrNoRows) {
		return b, projectagent.ErrLeaseLost
	}
	if err != nil {
		return b, err
	}
	var nodeID string
	err = tx.QueryRow(ctx, `SELECT n.id::text FROM nodes n JOIN node_credentials cr ON cr.node_id=n.id JOIN node_presence np ON np.node_id=n.id
 WHERE n.id=$1 AND n.employee_id=$2 AND n.revoked_at IS NULL AND cr.id=$3 AND cr.revoked_at IS NULL AND cr.expires_at>clock_timestamp()
 AND np.conn_id=$4 AND np.online AND np.synced FOR SHARE OF n,cr,np`, src.NodeID, src.EmployeeID, src.CredentialID, src.ConnID).Scan(&nodeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return b, projectagent.ErrLeaseLost
	}
	if err != nil {
		return b, err
	}
	// 节点或在线记录的锁等待也可能跨过期限，全部锁就绪后重新检查。
	if err = checkProjectLeaseTime(ctx, tx, b.agentID, req); err != nil {
		return b, err
	}
	return b, nil
}

func checkProjectLeaseTime(ctx context.Context, tx pgx.Tx, agentID string, req protocol.ProjectRuntimeRequest) error {
	var valid bool
	if err := tx.QueryRow(ctx, `SELECT lease_run_id=$2::uuid AND lease_epoch=$3 AND lease_until>clock_timestamp() FROM project_agents WHERE id=$1`, agentID, req.RunID, req.LeaseEpoch).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return projectagent.ErrLeaseLost
	}
	return nil
}

func (s *Store) ProjectRuntime(ctx context.Context, src protocol.Source, req protocol.ProjectRuntimeRequest) (any, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if req.Operation == "stopped" {
		if _, err = identity.ParseUUID(req.RunID); err != nil {
			return nil, projectagent.ErrLeaseLost
		}
		// 停止回执只确认节点已清理；不能恢复租约或写入对话。
		var current bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM nodes n JOIN node_credentials c ON c.node_id=n.id JOIN node_presence p ON p.node_id=n.id
        WHERE n.id=$1 AND n.employee_id=$2 AND c.id=$3 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND n.revoked_at IS NULL
        AND p.conn_id=$4 AND p.online AND p.synced)`, src.NodeID, src.EmployeeID, src.CredentialID, src.ConnID).Scan(&current); err != nil {
			return nil, err
		}
		if !current {
			return nil, projectagent.ErrLeaseLost
		}
		tag, err := tx.Exec(ctx, `UPDATE agent_runs SET stop_acked_at=clock_timestamp() WHERE id=$1 AND employee_id=$2 AND node_id=$3 AND lease_epoch=$4 AND state IN ('finished','lost','failed')`, req.RunID, src.EmployeeID, src.NodeID, req.LeaseEpoch)
		if err != nil {
			return nil, err
		}
		if tag.RowsAffected() != 1 {
			return nil, projectagent.ErrLeaseLost
		}
		return struct{}{}, tx.Commit(ctx)
	}
	b, err := validateProjectRun(ctx, tx, src, req)
	if err != nil {
		return nil, err
	}
	if strings.ContainsRune(req.Reason, 0) {
		return nil, projectagent.ErrInvalid
	}
	var data any
	released := false
	switch req.Operation {
	case "preview":
		var p projectagent.Preview
		if json.Unmarshal(req.Payload, &p) != nil || !utf8.ValidString(p.Text) || strings.ContainsRune(p.Text, 0) || len(p.Text) > 32<<10 {
			return nil, projectagent.ErrInvalid
		}
		if req.LastSeq != b.nextSeq-1 {
			return nil, projectagent.ErrConflict
		}
		data = struct{}{}
	case "renew", "started":
		if req.Operation == "started" {
			_, err = tx.Exec(ctx, `UPDATE agent_runs SET state='running' WHERE id=$1 AND state='starting'`, req.RunID)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE project_agents SET lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1 AND lease_until>clock_timestamp()`, b.agentID)
		}
		data = struct {
			LeaseSeconds int `json:"lease_seconds"`
		}{60}
	case "bootstrap":
		data, err = s.bootstrapProjectRun(ctx, tx, b)
	case "read_events":
		data, err = readProjectRunEvents(ctx, tx, b, req.AfterSeq, req.MaxBytes)
	case "claim_inputs":
		if req.LastSeq != b.nextSeq-1 {
			return nil, projectagent.ErrConflict
		}
		data, err = claimProjectInputs(ctx, tx, b, req)
	case "wait_tool":
		data, err = s.waitProjectTool(ctx, tx, b, req)
	case "call_tool":
		data, err = s.callProjectTool(ctx, tx, b, req)
	case "append_event":
		data, err = appendProjectAssistant(ctx, tx, b, req)
	case "finish", "exited", "start_failed", "report_failure":
		reason := boundedText(req.Reason, 1024)
		state := "finished"
		if req.Operation == "report_failure" {
			state = "failed"
			_, err = tx.Exec(ctx, `UPDATE conversations SET failure_count=failure_count+1,
    next_attempt_at=clock_timestamp()+CASE WHEN failure_count=0 THEN interval '1 minute' WHEN failure_count=1 THEN interval '5 minutes' ELSE interval '15 minutes' END,
    state=CASE WHEN failure_count>=2 THEN 'needs_attention' ELSE 'active' END,attention_reason=$2 WHERE id=$1`, b.conversationID, reason)
			if err == nil {
				var state string
				err = tx.QueryRow(ctx, `SELECT state FROM conversations WHERE id=$1`, b.conversationID).Scan(&state)
				if err == nil && state == "needs_attention" {
					err = inbox.CreateSystem(ctx, tx, inboxBinding(b), inbox.ProjectNeedsAttention, b.projectID, "Project 需要处理", reason, "", nil, nil)
				}
			}
		} else if req.Operation == "exited" {
			state = "lost"
		} else if req.Operation == "start_failed" {
			state = "failed"
		}
		if err == nil {
			err = checkProjectLeaseTime(ctx, tx, b.agentID, req)
		}
		if err == nil {
			err = releaseProjectRun(ctx, tx, b.agentID, state, reason)
			released = true
		}
		data = struct{}{}
	default:
		return nil, projectagent.ErrInvalid
	}
	if err != nil {
		return nil, err
	}
	if !released {
		if err = checkProjectLeaseTime(ctx, tx, b.agentID, req); err != nil {
			return nil, err
		}
	}
	return data, tx.Commit(ctx)
}

func (s *Store) bootstrapProjectRun(ctx context.Context, tx pgx.Tx, b projectRunBinding) (projectagent.Bootstrap, error) {
	out := projectagent.Bootstrap{PromptVersion: b.prompt, LastSeq: b.nextSeq - 1}
	p, err := scanProject(tx.QueryRow(ctx, projectSelect+` WHERE p.id=$1`, b.projectID))
	if err != nil {
		return out, err
	}
	p.Agent.Provider, p.Agent.Model = b.provider, b.model
	out.Project = p
	var compact *int64
	if err = tx.QueryRow(ctx, `SELECT compaction_seq FROM conversations WHERE id=$1`, b.conversationID).Scan(&compact); err != nil {
		return out, err
	}
	if compact != nil {
		e, err := scanProjectEvent(tx.QueryRow(ctx, projectEventSelect+` WHERE conversation_id=$1 AND seq=$2`, b.conversationID, *compact))
		if err != nil {
			return out, err
		}
		var payload struct {
			ThroughSeq int64 `json:"through_seq"`
		}
		if json.Unmarshal(e.Payload, &payload) != nil || payload.ThroughSeq < 0 || payload.ThroughSeq >= e.Seq {
			return out, projectagent.ErrInvalid
		}
		out.Compaction = &e
		out.CompactionSeq = e.Seq
		out.AfterSeq = payload.ThroughSeq
	}
	raw, _ := protocol.MarshalJSON(out)
	if len(raw) > protocol.MaxProjectRuntimeBytes-1024 {
		// 配置与摘要之和可能超过单帧；摘要仍在后续事件分页中，返回明确的序号。
		out.Compaction = nil
		raw, _ = protocol.MarshalJSON(out)
		if len(raw) > protocol.MaxProjectRuntimeBytes-1024 {
			// 非 NUL 控制字符的 JSON 转义可达原文的六倍，UTF-8 base64 保留完整目标且长度有界。
			out.GoalUTF8Base64 = base64.StdEncoding.EncodeToString([]byte(out.Project.Goal))
			out.Project.Goal = ""
			raw, _ = protocol.MarshalJSON(out)
			if len(raw) > protocol.MaxProjectRuntimeBytes-1024 {
				return out, projectagent.ErrTooLarge
			}
		}
	}
	return out, nil
}

const projectEventSelect = `SELECT conversation_id::text,seq,kind,client_event_id,tool_call_id,run_id::text,lease_epoch,payload,created_at FROM conversation_events`

func scanProjectEvent(row pgx.Row) (projectagent.Event, error) {
	var e projectagent.Event
	err := row.Scan(&e.ConversationID, &e.Seq, &e.Kind, &e.ClientEventID, &e.ToolCallID, &e.RunID, &e.LeaseEpoch, &e.Payload, &e.CreatedAt)
	return e, err
}

func readProjectRunEvents(ctx context.Context, tx pgx.Tx, b projectRunBinding, after int64, maxBytes int) (projectagent.EventPage, error) {
	out := projectagent.EventPage{Events: []projectagent.Event{}, NextAfterSeq: after, LastSeq: b.nextSeq - 1}
	if maxBytes == 0 {
		maxBytes = 128 << 10
	}
	if after < 0 || after > out.LastSeq || maxBytes < 1 || maxBytes > 128<<10 {
		return out, projectagent.ErrInvalid
	}
	rows, err := tx.Query(ctx, projectEventSelect+` WHERE conversation_id=$1 AND seq>$2 AND seq<=$3 ORDER BY seq LIMIT 100`, b.conversationID, after, out.LastSeq)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	size := 0
	for rows.Next() {
		e, err := scanProjectEvent(rows)
		if err != nil {
			return out, err
		}
		raw, err := protocol.MarshalJSON(e)
		if err != nil {
			return out, err
		}
		if len(raw) > protocol.MaxProjectRuntimeBytes-2048 {
			return out, projectagent.ErrTooLarge
		}
		if len(out.Events) > 0 && size+len(raw) > maxBytes {
			break
		}
		size += len(raw)
		out.Events = append(out.Events, e)
		out.NextAfterSeq = e.Seq
	}
	out.HasMore = out.NextAfterSeq < out.LastSeq
	return out, rows.Err()
}

func appendProjectAssistant(ctx context.Context, tx pgx.Tx, b projectRunBinding, req protocol.ProjectRuntimeRequest) (projectagent.Event, error) {
	var out projectagent.Event
	if req.ClientEventID == "" || len(req.ClientEventID) > 128 || !json.Valid(req.Payload) {
		return out, projectagent.ErrInvalid
	}
	var payload struct {
		Format  string `json:"format"`
		Message struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(req.Payload, &payload) != nil || payload.Format != "pi-ai/1" || payload.Message.Role != "assistant" || len(payload.Message.Content) == 0 || payload.Message.Content[0] != '[' {
		return out, projectagent.ErrInvalid
	}
	var canonical []byte
	if err := tx.QueryRow(ctx, `SELECT $1::jsonb::text`, req.Payload).Scan(&canonical); err != nil {
		return out, projectagent.ErrInvalid
	}
	wire, _ := protocol.MarshalJSON(json.RawMessage(canonical))
	if len(canonical) > projectagent.MaxEventBytes || len(wire) > projectagent.MaxEventBytes {
		return out, projectagent.ErrTooLarge
	}
	e, err := scanProjectEvent(tx.QueryRow(ctx, projectEventSelect+` WHERE conversation_id=$1 AND client_event_id=$2`, b.conversationID, req.ClientEventID))
	if err == nil {
		var equal bool
		err = tx.QueryRow(ctx, `SELECT $1::jsonb=$2::jsonb`, e.Payload, req.Payload).Scan(&equal)
		if err != nil {
			return out, err
		}
		if !equal || e.Kind != "assistant" {
			return out, projectagent.ErrConflict
		}
		return e, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	if req.LastSeq != b.nextSeq-1 {
		return out, projectagent.ErrConflict
	}
	var blocks []savedToolCall
	if json.Unmarshal(payload.Message.Content, &blocks) != nil {
		return out, projectagent.ErrInvalid
	}
	ids := map[string]bool{}
	for _, block := range blocks {
		if block.Type != "toolCall" {
			continue
		}
		if block.ID == "" || len(block.ID) > 128 || len(block.Name) > 128 || ids[block.ID] {
			return out, projectagent.ErrInvalid
		}
		ids[block.ID] = true
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM conversation_events WHERE conversation_id=$1 AND
  (tool_call_id=$2 OR (kind='assistant' AND EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'message'->'content') c WHERE c->>'type'='toolCall' AND c->>'id'=$2))))`, b.conversationID, block.ID).Scan(&exists); err != nil {
			return out, err
		}
		if exists {
			return out, projectagent.ErrConflict
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,client_event_id,run_id,lease_epoch,payload)
 VALUES($1,$2,$3,'assistant',$4,$5,$6,$7)`, b.conversationID, b.nextSeq, b.owner, req.ClientEventID, req.RunID, req.LeaseEpoch, req.Payload); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, `UPDATE conversations SET next_seq=next_seq+1,failure_count=0,next_attempt_at=NULL,attention_reason=NULL WHERE id=$1`, b.conversationID); err != nil {
		return out, err
	}
	return scanProjectEvent(tx.QueryRow(ctx, projectEventSelect+` WHERE conversation_id=$1 AND seq=$2`, b.conversationID, b.nextSeq))
}

func claimProjectInputs(ctx context.Context, tx pgx.Tx, b projectRunBinding, req protocol.ProjectRuntimeRequest) (projectagent.Claim, error) {
	out := projectagent.Claim{}
	var active bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM project_agent_input_queue WHERE agent_id=$1 AND delivered_seq IS NULL AND source_type IN ('user_message','task_result','attention_answer'))`, b.agentID).Scan(&active); err != nil {
		return out, err
	}
	if !active {
		return out, nil
	}
	// 记忆的旧通知在查询时折叠，不受一批条数上限影响；领取最新通知时一起标为已投递。
	rows, err := tx.Query(ctx, `SELECT q.id,q.source_type,q.source_key,q.payload,octet_length(q.payload::text) FROM project_agent_input_queue q
 WHERE q.agent_id=$1 AND q.delivered_seq IS NULL AND (q.source_type<>'memory_updated' OR NOT EXISTS(
 SELECT 1 FROM project_agent_input_queue newer WHERE newer.agent_id=q.agent_id AND newer.delivered_seq IS NULL AND newer.source_type='memory_updated'
 AND newer.payload->>'entry_id'=q.payload->>'entry_id' AND (newer.payload->>'revision')::bigint>(q.payload->>'revision')::bigint)) ORDER BY q.id LIMIT 20`, b.agentID)
	if err != nil {
		return out, err
	}
	var inputs []projectagent.QueuedInput
	var sizes []int
	for rows.Next() {
		var q projectagent.QueuedInput
		var size int
		if err = rows.Scan(&q.ID, &q.SourceType, &q.SourceKey, &q.Payload, &size); err != nil {
			rows.Close()
			return out, err
		}
		inputs = append(inputs, q)
		sizes = append(sizes, size)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	chosen := []projectagent.QueuedInput{}
	ids := []int64{}
	var eventPayload []byte
	for i, q := range inputs {
		raw, _ := protocol.MarshalJSON(q.Payload)
		size := max(sizes[i], len(raw))
		if out.PayloadBytes+size > projectagent.MaxClaimBytes {
			break
		}
		trial := append(append([]projectagent.QueuedInput{}, chosen...), q)
		trialIDs := append(append([]int64{}, ids...), q.ID)
		text, _ := protocol.MarshalJSON(trial)
		payload := struct {
			Format   string  `json:"format"`
			Message  any     `json:"message"`
			InputIDs []int64 `json:"input_ids"`
		}{"pi-ai/1", struct {
			Role      string `json:"role"`
			Content   any    `json:"content"`
			Timestamp int64  `json:"timestamp"`
		}{"user", []any{struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}{"text", string(text)}}, 0}, trialIDs}
		encoded, _ := protocol.MarshalJSON(payload)
		// JSON 文本进入消息后会再次转义；同时检查传输表示和数据库规范文本。
		var dbSize int
		if err = tx.QueryRow(ctx, `SELECT octet_length($1::jsonb::text)`, encoded).Scan(&dbSize); err != nil {
			return out, err
		}
		if len(encoded) > projectagent.MaxEventBytes || dbSize > projectagent.MaxEventBytes {
			break
		}
		chosen, ids, eventPayload = trial, trialIDs, encoded
		out.PayloadBytes += size
	}
	if len(chosen) == 0 {
		return out, projectagent.ErrTooLarge
	}
	if _, err = tx.Exec(ctx, `INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,run_id,lease_epoch,payload) VALUES($1,$2,$3,'input',$4,$5,$6)`, b.conversationID, b.nextSeq, b.owner, req.RunID, req.LeaseEpoch, eventPayload); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, `UPDATE project_agent_input_queue q SET delivered_seq=$2 WHERE q.agent_id=$1 AND q.delivered_seq IS NULL AND
 (q.id=ANY($3::bigint[]) OR (q.source_type='memory_updated' AND EXISTS(SELECT 1 FROM project_agent_input_queue selected
 WHERE selected.id=ANY($3::bigint[]) AND selected.source_type='memory_updated' AND selected.payload->>'entry_id'=q.payload->>'entry_id'
 AND (selected.payload->>'revision')::bigint>=(q.payload->>'revision')::bigint)))`, b.agentID, b.nextSeq, ids); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, `UPDATE conversations SET next_seq=next_seq+1 WHERE id=$1`, b.conversationID); err != nil {
		return out, err
	}
	e, err := scanProjectEvent(tx.QueryRow(ctx, projectEventSelect+` WHERE conversation_id=$1 AND seq=$2`, b.conversationID, b.nextSeq))
	out.Event = &e
	out.InputCount = len(chosen)
	return out, err
}
