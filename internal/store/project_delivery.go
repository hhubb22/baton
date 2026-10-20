package store

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"baton/internal/delivery"
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"github.com/jackc/pgx/v5"
)

const projectDeliveryBatch = 32

// ProjectRunCommands 领取三类命令；提交重试时间后才返回，调用方不再更新发送结果。
func (s *Store) ProjectRunCommands(ctx context.Context) ([]projectagent.RunCommand, error) {
	out := []projectagent.RunCommand{}
	for _, kind := range []string{protocol.BodyProjectRunStart, protocol.BodyProjectRunStop, protocol.BodyProjectRunWake} {
		commands, err := s.ClaimProjectRunCommands(ctx, kind)
		if err != nil {
			return out, err
		}
		out = append(out, commands...)
	}
	return out, nil
}

// ClaimProjectRunCommands 每类至多领取 32 条，每节点至多两条。网络发送必须在返回后进行。
func (s *Store) ClaimProjectRunCommands(ctx context.Context, kind string) ([]projectagent.RunCommand, error) {
	if kind != protocol.BodyProjectRunStart && kind != protocol.BodyProjectRunStop && kind != protocol.BodyProjectRunWake {
		return nil, projectagent.ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var out []projectagent.RunCommand
	if kind == protocol.BodyProjectRunWake {
		out, err = claimProjectWakes(ctx, tx)
	} else {
		out, err = claimProjectCommands(ctx, tx, kind)
	}
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

const projectCommandColumns = `r.id::text,r.node_id::text,p.conn_id,r.lease_epoch,r.provider,r.model,a.project_id::text,c.id::text`

func scanProjectCommand(rows pgx.Rows, c *projectagent.RunCommand, rest ...any) error {
	args := []any{&c.Command.RunID, &c.NodeID, &c.ConnID, &c.Command.LeaseEpoch, &c.Command.Provider, &c.Command.Model, &c.Command.ProjectID, &c.Command.ConversationID}
	return rows.Scan(append(args, rest...)...)
}

func claimProjectCommands(ctx context.Context, tx pgx.Tx, kind string) ([]projectagent.RunCommand, error) {
	predicate := `r.stop_requested_at IS NOT NULL AND r.stop_acked_at IS NULL`
	if kind == protocol.BodyProjectRunStart {
		predicate = `r.state='starting' AND r.stop_requested_at IS NULL
 AND a.lease_run_id=r.id AND a.lease_epoch=r.lease_epoch AND a.lease_until>clock_timestamp() AND pr.status='active'`
	}
	// 节点按最早到期工作排序。内层跳锁后计节点额度，外层流式 LIMIT 限制总行锁数。
	rows, err := tx.Query(ctx, `WITH candidates AS MATERIALIZED (
 SELECT p.node_id,p.conn_id FROM node_presence p JOIN nodes n ON n.id=p.node_id
 CROSS JOIN LATERAL (
 SELECT r.id,r.command_next_at FROM agent_runs r JOIN project_agents a ON a.id=r.agent_id
 JOIN projects pr ON pr.id=a.project_id
 WHERE r.node_id=p.node_id AND `+predicate+` AND r.command_next_at<=statement_timestamp()
 ORDER BY r.command_next_at,r.id LIMIT 1
 ) due WHERE p.online AND p.synced AND n.revoked_at IS NULL
 ORDER BY due.command_next_at,due.id
 ) SELECT command.* FROM candidates p CROSS JOIN LATERAL (
 SELECT `+projectCommandColumns+`,r.command_attempts,clock_timestamp()
 FROM agent_runs r JOIN project_agents a ON a.id=r.agent_id
 JOIN projects pr ON pr.id=a.project_id JOIN conversations c ON c.agent_id=a.id
 WHERE r.node_id=p.node_id AND `+predicate+` AND r.command_next_at<=statement_timestamp()
 ORDER BY r.command_next_at,r.id LIMIT 2 FOR UPDATE OF r SKIP LOCKED
 ) command LIMIT 32`)
	if err != nil {
		return nil, err
	}
	type claimed struct {
		command projectagent.RunCommand
		attempt int
		now     time.Time
	}
	var claims []claimed
	for rows.Next() {
		var c claimed
		c.command.Command.Type = kind
		if err = scanProjectCommand(rows, &c.command, &c.attempt, &c.now); err != nil {
			rows.Close()
			return nil, err
		}
		claims = append(claims, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	out := make([]projectagent.RunCommand, 0, len(claims))
	ids := make([]string, 0, len(claims))
	next := make([]time.Time, 0, len(claims))
	for _, c := range claims {
		ids = append(ids, c.command.Command.RunID)
		next = append(next, delivery.NextAttempt(c.now, c.attempt+1, time.Second))
		out = append(out, c.command)
	}
	if len(ids) > 0 {
		_, err = tx.Exec(ctx, `UPDATE agent_runs r SET command_attempts=LEAST(r.command_attempts::bigint+1,2147483647)::integer,command_next_at=d.next_at
 FROM unnest($1::uuid[],$2::timestamptz[]) AS d(id,next_at) WHERE r.id=d.id`, ids, next)
	}
	return out, err
}

func claimProjectWakes(ctx context.Context, tx pgx.Tx) ([]projectagent.RunCommand, error) {
	// 外层不再排序锁定结果，LIMIT 32 直接停止后续节点的锁定读取。
	rows, err := tx.Query(ctx, `WITH candidates AS MATERIALIZED (
 SELECT p.node_id,p.conn_id FROM node_presence p JOIN nodes n ON n.id=p.node_id
 CROSS JOIN LATERAL (
 SELECT q.wake_next_at,q.id FROM agent_runs r
 JOIN project_agents a ON a.lease_run_id=r.id AND a.lease_epoch=r.lease_epoch
 JOIN projects pr ON pr.id=a.project_id
 CROSS JOIN LATERAL (
 SELECT q.id,q.wake_next_at FROM project_agent_input_queue q WHERE q.agent_id=a.id
 AND q.delivered_seq IS NULL AND q.wake_required AND q.wake_next_at<=statement_timestamp()
 ORDER BY q.wake_next_at,q.id LIMIT 1
 ) q WHERE r.node_id=p.node_id AND r.state='running' AND r.stop_requested_at IS NULL
 AND a.lease_until>clock_timestamp() AND pr.status='active'
 ORDER BY q.wake_next_at,q.id LIMIT 1
 ) due WHERE p.online AND p.synced AND n.revoked_at IS NULL
 ORDER BY due.wake_next_at,due.id
 ) SELECT command.* FROM candidates p CROSS JOIN LATERAL (
 SELECT `+projectCommandColumns+`,a.id::text
 FROM agent_runs r JOIN project_agents a ON a.lease_run_id=r.id AND a.lease_epoch=r.lease_epoch
 JOIN projects pr ON pr.id=a.project_id JOIN conversations c ON c.agent_id=a.id
 CROSS JOIN LATERAL (
 SELECT q.id,q.wake_next_at FROM project_agent_input_queue q WHERE q.agent_id=a.id
 AND q.delivered_seq IS NULL AND q.wake_required AND q.wake_next_at<=statement_timestamp()
 ORDER BY q.wake_next_at,q.id LIMIT 1
 ) q WHERE r.node_id=p.node_id AND r.state='running' AND r.stop_requested_at IS NULL
 AND a.lease_until>clock_timestamp() AND pr.status='active'
 ORDER BY q.wake_next_at,q.id LIMIT 2 FOR NO KEY UPDATE OF a SKIP LOCKED
 ) command LIMIT 32`)
	if err != nil {
		return nil, err
	}
	type wake struct {
		command projectagent.RunCommand
		agentID string
	}
	var wakes []wake
	for rows.Next() {
		var w wake
		w.command.Command.Type = protocol.BodyProjectRunWake
		if err = scanProjectCommand(rows, &w.command, &w.agentID); err != nil {
			rows.Close()
			return nil, err
		}
		wakes = append(wakes, w)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	out := make([]projectagent.RunCommand, 0, len(wakes))
	var inputIDs []int64
	var nextTimes []time.Time
	for _, w := range wakes {
		// Agent 锁串行化运行更换、接收确认与通知领取。
		var valid bool
		if err = tx.QueryRow(ctx, `SELECT a.lease_run_id=$2::uuid AND a.lease_epoch=$3 AND a.lease_until>clock_timestamp()
 AND r.state='running' AND r.stop_requested_at IS NULL AND pr.status='active'
 FROM project_agents a JOIN agent_runs r ON r.id=$2 JOIN projects pr ON pr.id=a.project_id WHERE a.id=$1`, w.agentID, w.command.Command.RunID, w.command.Command.LeaseEpoch).Scan(&valid); err != nil {
			return nil, err
		}
		if !valid {
			continue
		}
		inputs, err := tx.Query(ctx, `SELECT id,source_type,payload,wake_attempts,clock_timestamp()
 FROM project_agent_input_queue WHERE agent_id=$1 AND delivered_seq IS NULL AND wake_required AND wake_next_at<=statement_timestamp()
 ORDER BY wake_next_at,id LIMIT 32 FOR UPDATE SKIP LOCKED`, w.agentID)
		if err != nil {
			return nil, err
		}
		type input struct {
			id      int64
			kind    string
			payload []byte
			attempt int
			now     time.Time
		}
		var chosen []input
		for inputs.Next() {
			var i input
			if err = inputs.Scan(&i.id, &i.kind, &i.payload, &i.attempt, &i.now); err != nil {
				inputs.Close()
				return nil, err
			}
			chosen = append(chosen, i)
		}
		err = inputs.Err()
		inputs.Close()
		if err != nil {
			return nil, err
		}
		for len(chosen) > 0 {
			w.command.Command.InputIDs = nil
			w.command.Command.TaskUpdates = nil
			updates := map[string]int64{}
			for _, i := range chosen {
				w.command.Command.InputIDs = append(w.command.Command.InputIDs, i.id)
				if i.kind == "task_result" || i.kind == "user_task_result" {
					var u protocol.ProjectTaskUpdate
					if err = json.Unmarshal(i.payload, &u); err != nil {
						return nil, err
					}
					if u.TaskID != "" && u.Version > updates[u.TaskID] {
						updates[u.TaskID] = u.Version
					}
				}
			}
			for id, version := range updates {
				w.command.Command.TaskUpdates = append(w.command.Command.TaskUpdates, protocol.ProjectTaskUpdate{TaskID: id, Version: version})
			}
			sort.Slice(w.command.Command.TaskUpdates, func(i, j int) bool {
				return w.command.Command.TaskUpdates[i].TaskID < w.command.Command.TaskUpdates[j].TaskID
			})
			raw, err := protocol.MarshalJSON(w.command.Command)
			if err != nil {
				return nil, err
			}
			if len(raw) <= protocol.MaxProjectRuntimeBytes-1024 {
				break
			}
			if len(chosen) == 1 {
				return nil, projectagent.ErrTooLarge
			}
			chosen = chosen[:len(chosen)/2]
		}
		if len(chosen) == 0 {
			continue
		}
		for _, i := range chosen {
			inputIDs = append(inputIDs, i.id)
			nextTimes = append(nextTimes, delivery.NextAttempt(i.now, i.attempt+1, time.Second))
		}
		out = append(out, w.command)
	}
	if len(inputIDs) > 0 {
		_, err = tx.Exec(ctx, `UPDATE project_agent_input_queue q SET wake_attempts=LEAST(q.wake_attempts::bigint+1,2147483647)::integer,wake_next_at=d.next_at
 FROM unnest($1::bigint[],$2::timestamptz[]) AS d(id,next_at) WHERE q.id=d.id`, inputIDs, nextTimes)
	}
	return out, err
}

func acknowledgeProjectWake(ctx context.Context, tx pgx.Tx, agentID string, payload json.RawMessage) error {
	var receipt struct {
		InputIDs []int64 `json:"input_ids"`
	}
	if json.Unmarshal(payload, &receipt) != nil || len(receipt.InputIDs) == 0 || len(receipt.InputIDs) > projectDeliveryBatch {
		return projectagent.ErrInvalid
	}
	seen := make(map[int64]bool, len(receipt.InputIDs))
	for _, id := range receipt.InputIDs {
		if id <= 0 || seen[id] {
			return projectagent.ErrInvalid
		}
		seen[id] = true
	}
	_, err := tx.Exec(ctx, `UPDATE project_agent_input_queue SET wake_required=false
 WHERE agent_id=$1 AND id=ANY($2::bigint[]) AND delivered_seq IS NULL AND wake_required`, agentID, receipt.InputIDs)
	return err
}

// ListProjectRunCandidates 按 Agent ID 分页，调用方在一轮结束后从头继续扫描。
func (s *Store) ListProjectRunCandidates(ctx context.Context, afterID string, limit int) ([]string, error) {
	if limit < 1 || limit > 100 {
		return nil, projectagent.ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT a.id::text FROM project_agents a JOIN projects p ON p.id=a.project_id
 JOIN conversations c ON c.agent_id=a.id WHERE ($1::uuid IS NULL OR a.id>$1::uuid) AND `+projectPlacementCandidate+` ORDER BY a.id LIMIT $2`, nullableProjectID(afterID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ScheduleProjectRun 在单个有界事务内放置或回收一个 Agent；忙碌的 Agent 直接跳过。
func (s *Store) ScheduleProjectRun(ctx context.Context, agentID string) error {
	return s.scheduleProjectRun(ctx, agentID)
}
