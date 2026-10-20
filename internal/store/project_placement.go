package store

import (
	"context"
	"encoding/json"
	"errors"

	"baton/internal/identity"
	"baton/internal/inbox"
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// recoveryWork 只把尚未完成的主动轮次视作恢复工作，被动通知不参与放置。
const recoveryWork = `(EXISTS(SELECT 1 FROM project_agent_input_queue q WHERE q.agent_id=a.id AND delivered_seq IS NULL AND source_type IN ('user_message','task_result','attention_answer'))
 OR EXISTS(SELECT 1 FROM conversation_events e WHERE e.conversation_id=c.id AND e.seq=(SELECT max(t.seq) FROM conversation_events t WHERE t.conversation_id=c.id AND t.kind<>'compaction')
 AND (e.kind IN ('input','tool_result') OR (e.kind='assistant' AND jsonb_path_exists(e.payload,'$.message.content[*] ? (@.type == "toolCall")')))))`

func releaseProjectRun(ctx context.Context, tx pgx.Tx, agentID, state, reason string) error {
	if _, err := tx.Exec(ctx, `UPDATE agent_runs r SET state=$2,ended_at=clock_timestamp(),end_reason=$3
 FROM project_agents a WHERE a.id=$1 AND r.id=a.lease_run_id AND r.state IN ('starting','running')`, agentID, state, reason); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE project_agents SET lease_run_id=NULL,lease_until=NULL WHERE id=$1`, agentID)
	return err
}

func (s *Store) ScheduleProjectRuns(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT a.id::text FROM project_agents a JOIN projects p ON p.id=a.project_id
 JOIN conversations c ON c.agent_id=a.id WHERE a.lease_run_id IS NOT NULL OR
 (p.status='active' AND c.state='active' AND (c.next_attempt_at IS NULL OR c.next_attempt_at<=clock_timestamp()) AND `+recoveryWork+`) ORDER BY a.id`)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err = s.scheduleProjectRun(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) scheduleProjectRun(ctx context.Context, agentID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id string
	err = tx.QueryRow(ctx, `SELECT id::text FROM project_agents WHERE id=$1 FOR NO KEY UPDATE SKIP LOCKED`, agentID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var owner, projectID, convID, status, convState, provider, model string
	var runID *string
	var epoch int64
	var valid, ready, work bool
	err = tx.QueryRow(ctx, `SELECT a.employee_id::text,a.project_id::text,c.id::text,p.status,c.state,a.provider,a.model,a.lease_run_id::text,a.lease_epoch,
 COALESCE(a.lease_until>clock_timestamp(),false),c.next_attempt_at IS NULL OR c.next_attempt_at<=clock_timestamp(),`+recoveryWork+`
 FROM project_agents a JOIN projects p ON p.id=a.project_id JOIN conversations c ON c.agent_id=a.id WHERE a.id=$1`, agentID).
		Scan(&owner, &projectID, &convID, &status, &convState, &provider, &model, &runID, &epoch, &valid, &ready, &work)
	if err != nil {
		return err
	}
	if runID != nil {
		var revoked bool
		if err = tx.QueryRow(ctx, `SELECT n.revoked_at IS NOT NULL FROM agent_runs r JOIN nodes n ON n.id=r.node_id WHERE r.id=$1`, *runID).Scan(&revoked); err != nil {
			return err
		}
		if valid && status == "active" && !revoked {
			return tx.Commit(ctx)
		}
		state, reason := "lost", "lease_expired"
		if status != "active" {
			state, reason = "finished", "project_"+status
		}
		if revoked {
			reason = "node_revoked"
		}
		if err = releaseProjectRun(ctx, tx, agentID, state, reason); err != nil {
			return err
		}
	}
	if status != "active" || convState != "active" || !ready || !work || provider == "" || model == "" {
		return tx.Commit(ctx)
	}
	var defaultID *string
	if err = tx.QueryRow(ctx, `SELECT default_device_node_id::text FROM employee_settings WHERE employee_id=$1`, owner).Scan(&defaultID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	candidates, err := tx.Query(ctx, `SELECT n.id::text,COALESCE(p.conn_id,''),COALESCE(p.online AND p.synced,false),n.revoked_at IS NOT NULL,r.report
 FROM nodes n LEFT JOIN node_presence p ON p.node_id=n.id LEFT JOIN node_runtime_reports r ON r.node_id=n.id
 WHERE n.employee_id=$1 ORDER BY CASE WHEN n.id=$2::uuid THEN 0 ELSE 1 END,n.registration_seq`, owner, defaultID)
	if err != nil {
		return err
	}
	type candidate struct {
		id, conn        string
		online, revoked bool
		raw             []byte
	}
	var nodes []candidate
	for candidates.Next() {
		var n candidate
		if err = candidates.Scan(&n.id, &n.conn, &n.online, &n.revoked, &n.raw); err != nil {
			candidates.Close()
			return err
		}
		nodes = append(nodes, n)
	}
	err = candidates.Err()
	candidates.Close()
	if err != nil {
		return err
	}
	reason := "default_not_set"
	if defaultID != nil {
		reason = "default_unavailable"
	}
	chosen := ""
	for _, n := range nodes {
		why := ""
		switch {
		case n.revoked:
			why = "revoked"
		case !n.online:
			why = "offline"
		default:
			var r protocol.RuntimeReport
			if json.Unmarshal(n.raw, &r) != nil || r.ProjectRuntime == nil {
				why = "runtime_missing"
			} else {
				why = "login_required"
				for _, p := range r.ProjectRuntime.Providers {
					if p.Provider == provider && p.Status == "available" {
						why = ""
						break
					}
				}
			}
		}
		if why == "" {
			// 节点行锁串行化名额分配，与报告/吊销共用该锁。
			var eligible bool
			err = tx.QueryRow(ctx, `SELECT n.revoked_at IS NULL AND COALESCE(p.online AND p.synced,false) FROM nodes n LEFT JOIN node_presence p ON p.node_id=n.id WHERE n.id=$1 FOR UPDATE OF n`, n.id).Scan(&eligible)
			if err != nil {
				return err
			}
			var count int
			if err = tx.QueryRow(ctx, `SELECT count(*) FROM agent_runs r JOIN project_agents a ON a.lease_run_id=r.id WHERE r.node_id=$1 AND a.lease_until>clock_timestamp()`, n.id).Scan(&count); err != nil {
				return err
			}
			if !eligible {
				why = "offline"
			} else if count >= 4 {
				why = "capacity"
			}
		}
		if defaultID != nil && n.id == *defaultID {
			if why == "" {
				reason = "default_device"
			} else {
				reason = "default_" + why
			}
		}
		if why == "" {
			chosen = n.id
			break
		}
	}
	if chosen == "" {
		return tx.Commit(ctx)
	}
	newRun, err := identity.NewUUID()
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE project_agents SET lease_epoch=lease_epoch+1,lease_run_id=$2,lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1`, agentID, newRun); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agent_runs(id,employee_id,agent_id,node_id,lease_epoch,state,provider,model,placement_reason)
 VALUES($1,$2,$3,$4,$5,'starting',$6,$7,$8)`, newRun, owner, agentID, chosen, epoch+1, provider, model, reason); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) ProjectRunCommands(ctx context.Context) ([]projectagent.RunCommand, error) {
	rows, err := s.pool.Query(ctx, `SELECT r.id::text,r.node_id::text,p.conn_id,r.lease_epoch,r.provider,r.model,a.project_id::text,c.id::text,
 CASE WHEN a.lease_run_id IS DISTINCT FROM r.id OR a.lease_until<=clock_timestamp() OR pr.status<>'active' THEN 'project_run_stop'
 WHEN r.state='starting' THEN 'project_run_start' ELSE 'project_run_wake' END
 FROM agent_runs r JOIN project_agents a ON a.id=r.agent_id JOIN projects pr ON pr.id=a.project_id JOIN conversations c ON c.agent_id=a.id
 JOIN node_presence p ON p.node_id=r.node_id WHERE p.online AND p.synced AND
 ((r.stop_acked_at IS NULL AND (a.lease_run_id IS DISTINCT FROM r.id OR a.lease_until<=clock_timestamp() OR pr.status<>'active')) OR
 (a.lease_run_id=r.id AND a.lease_until>clock_timestamp() AND (r.state='starting' OR EXISTS
 (SELECT 1 FROM project_agent_input_queue q WHERE q.agent_id=a.id AND delivered_seq IS NULL AND source_type IN ('user_message','task_result','attention_answer'))))) ORDER BY r.started_at LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []projectagent.RunCommand{}
	for rows.Next() {
		var c projectagent.RunCommand
		if err = rows.Scan(&c.Command.RunID, &c.NodeID, &c.ConnID, &c.Command.LeaseEpoch, &c.Command.Provider, &c.Command.Model, &c.Command.ProjectID, &c.Command.ConversationID, &c.Command.Type); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) RetryProject(ctx context.Context, owner, projectID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id string
	err = tx.QueryRow(ctx, `SELECT id::text FROM project_agents WHERE employee_id=$1 AND project_id=$2 FOR NO KEY UPDATE`, owner, projectID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE conversations SET state='active',failure_count=0,next_attempt_at=NULL,attention_reason=NULL WHERE agent_id=$1`, id); err != nil {
		return err
	}
	if err = inbox.ResolveSystem(ctx, tx, inbox.ProjectNeedsAttention, projectID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) StopProjectRun(ctx context.Context, owner, projectID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id string
	err = tx.QueryRow(ctx, `SELECT id::text FROM project_agents WHERE employee_id=$1 AND project_id=$2 FOR NO KEY UPDATE`, owner, projectID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if err = releaseProjectRun(ctx, tx, id, "finished", "user_stopped"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
