package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"baton/internal/identity"
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// readProjectToolWait 只决定重放或继续等待；最终结果由写事务重新校验并保存。
func (s *Store) readProjectToolWait(ctx context.Context, src protocol.Source, req protocol.ProjectRuntimeRequest) (any, bool, error) {
	if _, err := identity.ParseUUID(req.RunID); err != nil || req.LeaseEpoch < 1 {
		return nil, true, projectagent.ErrLeaseLost
	}
	// 身份、对话与 Thread 的所有读取共享快照，且不取得显式行锁。
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, true, err
	}
	defer tx.Rollback(ctx)
	var b projectRunBinding
	err = tx.QueryRow(ctx, `SELECT a.id::text,a.employee_id::text,a.project_id::text,c.id::text,c.next_seq
 FROM project_agents a JOIN agent_runs r ON r.id=a.lease_run_id AND r.agent_id=a.id
 JOIN projects p ON p.id=a.project_id JOIN conversations c ON c.agent_id=a.id
 JOIN nodes n ON n.id=r.node_id JOIN node_credentials cr ON cr.node_id=n.id JOIN node_presence np ON np.node_id=n.id
 WHERE r.id=$1 AND r.employee_id=$2 AND r.node_id=$3 AND a.lease_epoch=$4 AND r.lease_epoch=$4
 AND a.lease_until>clock_timestamp() AND r.state IN ('starting','running') AND p.status='active'
 AND n.employee_id=$2 AND n.revoked_at IS NULL AND cr.id=$5 AND cr.revoked_at IS NULL AND cr.expires_at>clock_timestamp()
 AND np.conn_id=$6 AND np.online AND np.synced`, req.RunID, src.EmployeeID, src.NodeID, req.LeaseEpoch, src.CredentialID, src.ConnID).
		Scan(&b.agentID, &b.owner, &b.projectID, &b.conversationID, &b.nextSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, true, projectagent.ErrLeaseLost
	}
	if err != nil {
		return nil, true, err
	}
	if strings.ContainsRune(req.Reason, 0) || req.ToolCallID == "" || len(req.ToolCallID) > 128 {
		return nil, true, projectagent.ErrInvalid
	}
	old, err := scanProjectEvent(tx.QueryRow(ctx, projectEventSelect+` WHERE conversation_id=$1 AND kind='tool_result' AND tool_call_id=$2`, b.conversationID, req.ToolCallID))
	if err == nil {
		return old, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, true, err
	}
	if req.LastSeq != b.nextSeq-1 {
		return nil, true, projectagent.ErrConflict
	}
	var force struct {
		Finish bool `json:"finish_wait"`
	}
	if len(req.Payload) > 0 && protocol.DecodeRuntimeJSON(req.Payload, &force) != nil {
		return nil, true, projectagent.ErrInvalid
	}
	if err = validateProjectExecCall(ctx, tx, b, req.ToolCallID); err != nil {
		return nil, true, err
	}
	p := projectToolPending{Pending: true, WaitProtocol: 1}
	var status string
	var ended bool
	var unexpired bool
	err = tx.QueryRow(ctx, `SELECT id::text,status,version,`+projectWaitRemainingSQL+`,exec_wait_until>clock_timestamp(),EXISTS(SELECT 1 FROM thread_turns v WHERE v.thread_id=threads.id AND v.ended_at IS NOT NULL)
 FROM threads WHERE employee_id=$1 AND project_id=$2 AND origin_conversation_id=$3 AND origin_tool_call_id=$4 AND agent_type='shell'`, b.owner, b.projectID, b.conversationID, req.ToolCallID).
		Scan(&p.ThreadID, &status, &p.Version, &p.WaitRemainingMS, &unexpired, &ended)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, true, projectagent.ErrInvalid
	}
	if err != nil {
		return nil, true, err
	}
	if !ended && status != "stopped" && status != "unknown" && status != "archived" && unexpired && !force.Finish {
		return p, true, nil
	}
	return nil, false, nil
}

func validateProjectExecCall(ctx context.Context, tx pgx.Tx, b projectRunBinding, callID string) error {
	var seq int64
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT seq,payload FROM conversation_events WHERE conversation_id=$1 AND kind='assistant' ORDER BY seq DESC LIMIT 1`, b.conversationID).Scan(&seq, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return projectagent.ErrInvalid
	}
	if err != nil {
		return err
	}
	var payload struct {
		Message struct {
			Content []savedToolCall `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return projectagent.ErrInvalid
	}
	found := false
	for _, call := range payload.Message.Content {
		if call.Type != "toolCall" {
			continue
		}
		if call.ID == callID {
			found = call.Name == "nodes.exec"
			break
		}
		var delivered bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM conversation_events WHERE conversation_id=$1 AND kind='tool_result' AND tool_call_id=$2)`, b.conversationID, call.ID).Scan(&delivered); err != nil {
			return err
		}
		if !delivered {
			return projectagent.ErrConflict
		}
	}
	if !found {
		return projectagent.ErrInvalid
	}
	var intervening bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM conversation_events WHERE conversation_id=$1 AND seq>$2 AND kind<>'tool_result')`, b.conversationID, seq).Scan(&intervening); err != nil {
		return err
	}
	if intervening {
		return projectagent.ErrConflict
	}
	return nil
}
