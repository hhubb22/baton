package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type ProjectRunView struct {
	ID              string     `json:"id"`
	NodeID          string     `json:"node_id"`
	NodeName        string     `json:"node_name"`
	State           string     `json:"state"`
	Effective       bool       `json:"effective"`
	PlacementReason string     `json:"placement_reason"`
	EndReason       *string    `json:"end_reason,omitempty"`
	StopAckedAt     *time.Time `json:"stop_acked_at,omitempty"`
}

type ProjectStatus struct {
	State         string                `json:"state"`
	WaitingReason string                `json:"waiting_reason,omitempty"`
	PendingInputs int                   `json:"pending_inputs"`
	LastError     *string               `json:"last_error,omitempty"`
	NextAttemptAt *time.Time            `json:"next_attempt_at,omitempty"`
	LastSeq       int64                 `json:"last_seq"`
	Run           *ProjectRunView       `json:"run,omitempty"`
	Preview       *projectagent.Preview `json:"preview,omitempty"`
}

// ProjectStatusView 使用同一只读快照取得队列、租约与设备事实。
func (s *Store) ProjectStatusView(ctx context.Context, owner, projectID string) (ProjectStatus, error) {
	out := ProjectStatus{}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	var agentID, status, provider, model, conversationState string
	var work bool
	err = tx.QueryRow(ctx, `SELECT a.id::text,p.status,a.provider,a.model,c.state,c.attention_reason,c.next_attempt_at,c.next_seq-1,
 (SELECT count(*) FROM project_agent_input_queue q WHERE q.agent_id=a.id AND q.delivered_seq IS NULL),`+recoveryWork+`
 FROM projects p JOIN project_agents a ON a.project_id=p.id JOIN conversations c ON c.agent_id=a.id WHERE p.employee_id=$1 AND p.id=$2`, owner, projectID).
		Scan(&agentID, &status, &provider, &model, &conversationState, &out.LastError, &out.NextAttemptAt, &out.LastSeq, &out.PendingInputs, &work)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	run := ProjectRunView{}
	err = tx.QueryRow(ctx, `SELECT r.id::text,r.node_id::text,n.display_name,r.state,
 COALESCE(a.lease_run_id=r.id AND a.lease_until>clock_timestamp() AND p.status='active' AND n.revoked_at IS NULL AND np.online AND np.synced,false),
 r.placement_reason,r.end_reason,r.stop_acked_at
 FROM agent_runs r JOIN project_agents a ON a.id=r.agent_id JOIN projects p ON p.id=a.project_id JOIN nodes n ON n.id=r.node_id LEFT JOIN node_presence np ON np.node_id=n.id
 WHERE r.agent_id=$1 ORDER BY r.started_at DESC,r.id DESC LIMIT 1`, agentID).
		Scan(&run.ID, &run.NodeID, &run.NodeName, &run.State, &run.Effective, &run.PlacementReason, &run.EndReason, &run.StopAckedAt)
	if err == nil {
		out.Run = &run
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	switch {
	case status != "active":
		out.State = status
	case conversationState == "needs_attention":
		out.State = "needs_attention"
	case out.Run != nil && out.Run.Effective:
		out.State = run.State
	case out.NextAttemptAt != nil && out.NextAttemptAt.After(time.Now()):
		out.State = "waiting"
		out.WaitingReason = "retry_backoff"
	case !work:
		out.State = "idle"
	case provider == "" || model == "":
		out.State = "waiting"
		out.WaitingReason = "model_not_configured"
	default:
		out.State = "waiting"
		out.WaitingReason = "all_devices_offline"
		rows, err := tx.Query(ctx, `SELECT COALESCE(np.online,false),COALESCE(np.synced,false),rr.report,
  (SELECT count(*) FROM agent_runs r JOIN project_agents pa ON pa.lease_run_id=r.id WHERE r.node_id=n.id AND pa.lease_until>clock_timestamp())
  FROM nodes n LEFT JOIN node_presence np ON np.node_id=n.id LEFT JOIN node_runtime_reports rr ON rr.node_id=n.id WHERE n.employee_id=$1 AND n.revoked_at IS NULL`, owner)
		if err != nil {
			return out, err
		}
		rank := 0
		for rows.Next() {
			var online, synced bool
			var raw []byte
			var count int
			if err = rows.Scan(&online, &synced, &raw, &count); err != nil {
				rows.Close()
				return out, err
			}
			why, n := "all_devices_offline", 0
			if online {
				why, n = "waiting_sync", 1
				if synced {
					why, n = "runtime_missing", 2
					var report protocol.RuntimeReport
					if json.Unmarshal(raw, &report) == nil && report.ProjectRuntime != nil {
						why, n = "login_required", 3
						for _, p := range report.ProjectRuntime.Providers {
							if p.Provider == provider && p.Status == "available" {
								why, n = "capacity", 4
								if count < 4 {
									why, n = "scheduling", 5
								}
								break
							}
						}
					}
				}
			}
			if n > rank {
				rank = n
				out.WaitingReason = why
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return out, err
		}
	}
	return out, tx.Commit(ctx)
}

type ProjectMessagePage struct {
	Messages    []projectagent.Message `json:"messages"`
	NextAfterID int64                  `json:"next_after_id,omitempty"`
}

// ProjectMessages 返回待领取消息；按客户端标识查询时也可恢复已经领取的原响应。
func (s *Store) ProjectMessages(ctx context.Context, owner, projectID, clientID string, after int64, limit int) (ProjectMessagePage, error) {
	out := ProjectMessagePage{Messages: []projectagent.Message{}}
	p, err := s.Project(ctx, owner, projectID)
	if err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id,substring(source_key from 6),payload->>'content',created_at FROM project_agent_input_queue
 WHERE employee_id=$1 AND agent_id=$2 AND source_type='user_message' AND id>$3
 AND (($4='' AND delivered_seq IS NULL) OR ($4<>'' AND source_key='user:'||$4)) ORDER BY id LIMIT $5`, owner, p.Agent.ID, after, clientID, limit+1)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var m projectagent.Message
		if err = rows.Scan(&m.ID, &m.ClientMessageID, &m.Content, &m.CreatedAt); err != nil {
			return out, err
		}
		out.Messages = append(out.Messages, m)
	}
	if len(out.Messages) > limit {
		out.Messages = out.Messages[:limit]
		out.NextAfterID = out.Messages[limit-1].ID
	}
	return out, rows.Err()
}
