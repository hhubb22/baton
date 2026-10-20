package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"baton/internal/delivery"
	"baton/internal/protocol"

	"baton/internal/identity"
	"baton/internal/redact"
	"baton/internal/task"

	"github.com/jackc/pgx/v5"
)

// PrepareIntent 是一条可以重发的 prepare。MessageID 在整个重发过程中保持不变。
type PrepareIntent struct {
	Envelope          json.RawMessage
	RequiredArtifacts []task.ArtifactRef
	MessageID         string
	EmployeeID        string
	TaskID            string
	ExecutionID       string
	NodeID            string
	AgentType         string
	TargetSessionID   string
	WorkingDirectory  string
	StorageGeneration string
	TaskVersion       int
	QueueExpiresAt    time.Time
}

// PreparedFact 是节点已经保存的准备映射。
type PreparedFact struct {
	MessageID         string
	EmployeeID        string
	NodeID            string
	TaskID            string
	ExecutionID       string
	SessionID         string
	StorageGeneration string
}

// ClaimPrepare 保留单条领取接口；尝试进度在返回前已经持久化。
func (s *Store) ClaimPrepare(ctx context.Context, lease time.Duration) (PrepareIntent, bool, error) {
	intents, err := s.ClaimPrepares(ctx, lease, 1)
	if err != nil || len(intents) == 0 {
		return PrepareIntent{}, false, err
	}
	return intents[0], true, nil
}

// ClaimPrepares 从每个在线且同步的节点各选一条，再按到期时间领取最多 32 条。
// 单活动 Coordinator 的 prepare 循环独占此入口；网络调用必须在提交后执行。
func (s *Store) ClaimPrepares(ctx context.Context, lease time.Duration, limit int) ([]PrepareIntent, error) {
	if lease <= 0 || limit <= 0 {
		return nil, errors.New("投递额度或租约无效")
	}
	if limit > 32 {
		limit = 32
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var now time.Time
	if err := tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
		return nil, err
	}
	// 节点内先按 Outbox → Task → Execution 加锁并跳过忙碌行，再计入 LIMIT 1。
	// 全局排序可能锁住未返回节点的候选，以及跳过候选时已锁住的前置行；这些锁随短事务提交释放。
	rows, err := tx.Query(ctx, `
		WITH eligible_nodes AS MATERIALIZED (
			SELECT p.node_id, p.employee_id
			FROM node_presence p
			JOIN nodes n ON n.id = p.node_id AND n.employee_id = p.employee_id
			WHERE p.online AND p.synced AND n.revoked_at IS NULL
			  AND NOT EXISTS (
				SELECT 1 FROM dispatch_outbox active
				WHERE active.target_node_id = p.node_id AND active.action = 'prepare'
				  AND active.acked_at IS NULL AND active.lease_until > $1
			  )
		)
		SELECT candidate.id::text
		FROM eligible_nodes p
		CROSS JOIN LATERAL (
			SELECT d.id, d.next_attempt_at
			FROM dispatch_outbox d
			JOIN tasks t ON t.id = d.task_id AND t.employee_id = d.employee_id
			JOIN executions e ON e.id = d.execution_id AND e.task_id = t.id AND e.employee_id = d.employee_id
			WHERE d.target_node_id = p.node_id AND d.employee_id = p.employee_id
			  AND d.action = 'prepare' AND d.acked_at IS NULL
			  AND d.next_attempt_at <= $1
			  AND (d.lease_until IS NULL OR d.lease_until <= $1)
			  AND (d.send_deadline > $1 OR d.may_have_been_sent)
			  AND t.status = 'queued' AND e.prepared_at IS NULL
			ORDER BY d.next_attempt_at, d.id
			LIMIT 1 FOR UPDATE OF d, t, e SKIP LOCKED
		) candidate
		ORDER BY candidate.next_attempt_at, candidate.id
		LIMIT $2`, now, limit)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	var intents []PrepareIntent
	for _, id := range ids {
		var intent PrepareIntent
		var targetSession, directory, generation *string
		var attempts int
		err := tx.QueryRow(ctx, `
			SELECT o.id::text, o.employee_id::text, o.task_id::text, o.execution_id::text, o.target_node_id::text,
			       t.version, t.agent_type, t.target_session_id::text, t.working_directory, t.queue_expires_at,
			       e.storage_generation, t.required_artifacts, o.attempts
			FROM dispatch_outbox o
			JOIN tasks t ON t.id = o.task_id AND t.employee_id = o.employee_id
			JOIN executions e ON e.id = o.execution_id AND e.task_id = t.id AND e.employee_id = o.employee_id
			JOIN node_presence p ON p.node_id = o.target_node_id AND p.employee_id = o.employee_id
			JOIN nodes n ON n.id = p.node_id AND n.employee_id = p.employee_id
			WHERE o.id = $1::uuid AND o.acked_at IS NULL AND t.status = 'queued' AND e.prepared_at IS NULL
			  AND p.online AND p.synced AND n.revoked_at IS NULL
			  AND NOT EXISTS (
				SELECT 1 FROM dispatch_outbox active WHERE active.target_node_id = o.target_node_id
				AND active.action = 'prepare' AND active.acked_at IS NULL AND active.lease_until > $2
			  )
			FOR UPDATE OF t, e SKIP LOCKED`, id, now).Scan(
			&intent.MessageID, &intent.EmployeeID, &intent.TaskID, &intent.ExecutionID, &intent.NodeID,
			&intent.TaskVersion, &intent.AgentType, &targetSession, &directory, &intent.QueueExpiresAt,
			&generation, &intent.RequiredArtifacts, &attempts)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if targetSession != nil {
			intent.TargetSessionID = *targetSession
		}
		if directory != nil {
			intent.WorkingDirectory = *directory
		}
		if generation != nil {
			intent.StorageGeneration = *generation
		}
		intent.QueueExpiresAt = intent.QueueExpiresAt.UTC()
		body, err := json.Marshal(protocol.PrepareCommand{
			Type: protocol.BodyPrepare, TaskID: intent.TaskID, ExecutionID: intent.ExecutionID,
			TaskVersion: intent.TaskVersion, StorageGeneration: intent.StorageGeneration,
			QueueExpiresAt: intent.QueueExpiresAt.Format(time.RFC3339Nano), AgentType: intent.AgentType,
			TargetSessionID: intent.TargetSessionID, WorkingDirectory: intent.WorkingDirectory,
			RequiredArtifacts: intent.RequiredArtifacts,
		})
		if err != nil {
			return nil, err
		}
		wire, err := json.Marshal(protocol.Envelope{
			Version: protocol.Version, MessageID: intent.MessageID, Route: protocol.Route{To: intent.NodeID},
			Priority: protocol.PriorityControl, Body: body,
		})
		if err != nil {
			return nil, err
		}
		_, wire, err = protocol.PrepareControlEnvelope(wire)
		if err != nil {
			return nil, err
		}
		intent.Envelope = wire
		next := delivery.NextAttempt(now, attempts+1, lease)
		if _, err := tx.Exec(ctx, `
			UPDATE dispatch_outbox SET attempts = attempts + 1, may_have_been_sent = true,
			    lease_until = $2, next_attempt_at = $3
			WHERE id = $1::uuid AND acked_at IS NULL`, id, now.Add(lease), next); err != nil {
			return nil, err
		}
		intents = append(intents, intent)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return intents, nil
}

// PrepareBinding 查找回包的持久化来源绑定，确认后仍可处理重复回包。
func (s *Store) PrepareBinding(ctx context.Context, messageID string) (PreparedFact, error) {
	var fact PreparedFact
	if _, err := identity.ParseUUID(messageID); err != nil {
		return fact, ErrNotFound
	}
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, employee_id::text, target_node_id::text, task_id::text, execution_id::text
		FROM dispatch_outbox WHERE id = $1::uuid AND action = 'prepare'`, messageID).Scan(
		&fact.MessageID, &fact.EmployeeID, &fact.NodeID, &fact.TaskID, &fact.ExecutionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return fact, ErrNotFound
	}
	return fact, err
}

// RetirePrepares 有界退役已不允许准备的记录，只锁 Outbox，读取任务已提交状态。
func (s *Store) RetirePrepares(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
		WITH retired AS (
			SELECT o.id FROM dispatch_outbox o
			JOIN tasks t ON t.id = o.task_id AND t.employee_id = o.employee_id
			JOIN executions e ON e.id = o.execution_id AND e.employee_id = o.employee_id
			WHERE o.acked_at IS NULL AND o.action = 'prepare'
			  AND (t.status <> 'queued' OR e.prepared_at IS NOT NULL)
			ORDER BY o.next_attempt_at, o.id LIMIT 32
			FOR UPDATE OF o SKIP LOCKED
		)
		UPDATE dispatch_outbox o SET acked_at = now()
		FROM retired r WHERE o.id = r.id AND o.acked_at IS NULL`)
	return err
}

// SavePrepared 在一个事务里保存准备事实。重复调用不会创建第二份 Session 或执行。
func (s *Store) SavePrepared(ctx context.Context, fact PreparedFact) error {
	if err := checkFact(fact); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("保存准备事实失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var acked *time.Time
	var executionID, taskID, nodeID string
	err = tx.QueryRow(ctx, `
		SELECT acked_at, execution_id::text, task_id::text, target_node_id::text
		FROM dispatch_outbox
		WHERE id = $1::uuid AND employee_id = $2::uuid
		FOR UPDATE`, fact.MessageID, fact.EmployeeID).Scan(&acked, &executionID, &taskID, &nodeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("找不到准备投递")
	}
	if err != nil {
		return fmt.Errorf("保存准备事实失败: %s", redact.Scrub(err.Error()))
	}
	if executionID != fact.ExecutionID || taskID != fact.TaskID || nodeID != fact.NodeID {
		return errors.New("准备结果与投递意图不一致")
	}
	if acked != nil {
		return tx.Commit(ctx)
	}
	var version int
	var status, agent, targetNode string
	var targetSession *string
	var queueExpires time.Time
	var execSeconds int
	err = tx.QueryRow(ctx, `
		SELECT version, status, agent_type, target_node_id::text, target_session_id::text,
		       queue_expires_at, execution_timeout_seconds
		FROM tasks
		WHERE id = $1::uuid AND employee_id = $2::uuid
		FOR UPDATE`, fact.TaskID, fact.EmployeeID).Scan(
		&version, &status, &agent, &targetNode, &targetSession, &queueExpires, &execSeconds,
	)
	if err != nil {
		return fmt.Errorf("保存准备事实失败: %s", redact.Scrub(err.Error()))
	}
	var preparedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT prepared_at
		FROM executions
		WHERE id = $1::uuid AND employee_id = $2::uuid AND task_id = $3::uuid
		FOR UPDATE`, fact.ExecutionID, fact.EmployeeID, fact.TaskID).Scan(&preparedAt)
	if err != nil {
		return fmt.Errorf("保存准备事实失败: %s", redact.Scrub(err.Error()))
	}
	if preparedAt != nil {
		if err := ackOutbox(ctx, tx, fact.MessageID); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if status != task.StatusQueued || targetNode != fact.NodeID {
		return errors.New("任务状态不能保存准备事实")
	}
	if targetSession != nil && *targetSession != fact.SessionID {
		if err := failLocked(ctx, tx, fact, version, agent, targetNode, queueExpires, execSeconds, task.CodeInvalidTarget, "准备结果的 Session 与任务不一致"); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if err := upsertPreparedSession(ctx, tx, fact, agent); err != nil {
		var rej *task.Rejection
		if errors.As(err, &rej) {
			if err := failLocked(ctx, tx, fact, version, agent, targetNode, queueExpires, execSeconds, rej.Code, rej.Message); err != nil {
				return err
			}
			return tx.Commit(ctx)
		}
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE executions
		SET prepared_at = now(), storage_generation = $3
		WHERE id = $1::uuid AND employee_id = $2::uuid AND prepared_at IS NULL`,
		fact.ExecutionID, fact.EmployeeID, fact.StorageGeneration); err != nil {
		return fmt.Errorf("保存准备事实失败: %s", redact.Scrub(err.Error()))
	}
	if _, err := tx.Exec(ctx, `
		UPDATE tasks
		SET target_session_id = $3::uuid, version = version + 1, updated_at = now()
		WHERE id = $1::uuid AND employee_id = $2::uuid`,
		fact.TaskID, fact.EmployeeID, fact.SessionID); err != nil {
		return fmt.Errorf("保存准备事实失败: %s", redact.Scrub(err.Error()))
	}
	if _, err := tx.Exec(ctx, `
		UPDATE task_relations
		SET target_session_id = $3::uuid, updated_at = now()
		WHERE employee_id = $1::uuid AND task_id = $2::uuid`,
		fact.EmployeeID, fact.TaskID, fact.SessionID); err != nil {
		return fmt.Errorf("保存准备事实失败: %s", redact.Scrub(err.Error()))
	}
	eventID, err := identity.NewUUID()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_events (
			id, task_id, employee_id, version, actor_employee_id, kind,
			status, target_node_id, agent_type, queue_expires_at,
			execution_timeout_seconds, reason_code, created_at
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4, $3::uuid, 'prepared',
			'queued', $5::uuid, $6, $7, $8, NULL, now()
		)`, eventID, fact.TaskID, fact.EmployeeID, version+1, fact.NodeID, agent, queueExpires, execSeconds); err != nil {
		return fmt.Errorf("保存准备事实失败: %s", redact.Scrub(err.Error()))
	}
	if err := ackOutbox(ctx, tx, fact.MessageID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func upsertPreparedSession(ctx context.Context, tx pgx.Tx, fact PreparedFact, agent string) error {
	var employeeID, nodeID, existingAgent, status string
	var bound *string
	err := tx.QueryRow(ctx, `
		SELECT employee_id::text, node_id::text, agent_type, status, bound_execution_id::text
		FROM sessions
		WHERE id = $1::uuid
		FOR UPDATE`, fact.SessionID).Scan(&employeeID, &nodeID, &existingAgent, &status, &bound)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `
			INSERT INTO sessions (
				id, employee_id, node_id, agent_type, status, bound_execution_id,
				storage_generation, created_at, updated_at
			) VALUES (
				$1::uuid, $2::uuid, $3::uuid, $4, 'idle', $5::uuid,
				$6, now(), now()
			)`, fact.SessionID, fact.EmployeeID, fact.NodeID, agent, fact.ExecutionID, fact.StorageGeneration)
		if err != nil {
			return fmt.Errorf("保存 Session 失败: %s", redact.Scrub(err.Error()))
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("读取 Session 失败: %s", redact.Scrub(err.Error()))
	}
	if employeeID != fact.EmployeeID || nodeID != fact.NodeID || existingAgent != agent {
		return &task.Rejection{Code: task.CodeUnsupported, Message: "Session 的 Agent 或归属与任务不一致"}
	}
	if bound != nil && *bound != fact.ExecutionID {
		return &task.Rejection{Code: task.CodeSessionBusy, Message: "Session 正在执行其他任务"}
	}
	tag, err := tx.Exec(ctx, `
		UPDATE sessions
		SET bound_execution_id = $2::uuid,
		    storage_generation = COALESCE(storage_generation, $3),
		    updated_at = now()
		WHERE id = $1::uuid
		  AND (bound_execution_id IS NULL OR bound_execution_id = $2::uuid)`,
		fact.SessionID, fact.ExecutionID, fact.StorageGeneration)
	if err != nil {
		return fmt.Errorf("保存 Session 失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() != 1 {
		return &task.Rejection{Code: task.CodeSessionBusy, Message: "Session 正在执行其他任务"}
	}
	return nil
}

// FailPrepare 记录节点明确拒绝的准备，并停止重发。已经准备成功的执行不会被改成失败。
func (s *Store) FailPrepare(ctx context.Context, fact PreparedFact, code, message string) error {
	return s.failPrepare(ctx, fact, code, message, false)
}

func (s *Store) failPrepare(ctx context.Context, fact PreparedFact, code, message string, onlyUnsent bool) error {
	if _, err := identity.ParseUUID(fact.MessageID); err != nil {
		return err
	}
	if !allowedPrepareCode(code) || message == "" {
		return errors.New("准备失败原因无效")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("保存准备失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var acked *time.Time
	var executionID, taskID, employeeID, targetNodeID string
	var mayHaveBeenSent bool
	var deadline time.Time
	err = tx.QueryRow(ctx, `
		SELECT acked_at, execution_id::text, task_id::text, employee_id::text, target_node_id::text,
		       may_have_been_sent, send_deadline
		FROM dispatch_outbox
		WHERE id = $1::uuid AND action = 'prepare'
		FOR UPDATE`, fact.MessageID).Scan(&acked, &executionID, &taskID, &employeeID, &targetNodeID, &mayHaveBeenSent, &deadline)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("找不到准备投递")
	}
	if err != nil {
		return fmt.Errorf("保存准备失败: %s", redact.Scrub(err.Error()))
	}
	if (fact.EmployeeID != "" && fact.EmployeeID != employeeID) ||
		(fact.NodeID != "" && fact.NodeID != targetNodeID) ||
		(fact.TaskID != "" && fact.TaskID != taskID) ||
		(fact.ExecutionID != "" && fact.ExecutionID != executionID) {
		return errors.New("准备结果与投递意图不一致")
	}
	if acked != nil {
		return tx.Commit(ctx)
	}
	if onlyUnsent {
		var now time.Time
		if err := tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
			return err
		}
		if mayHaveBeenSent || deadline.After(now) {
			return tx.Commit(ctx)
		}
	}
	fact.ExecutionID = executionID
	fact.TaskID = taskID
	fact.EmployeeID = employeeID
	var version int
	var status, agent, nodeID string
	var queueExpires time.Time
	var execSeconds int
	err = tx.QueryRow(ctx, `
		SELECT version, status, agent_type, target_node_id::text, queue_expires_at, execution_timeout_seconds
		FROM tasks
		WHERE id = $1::uuid AND employee_id = $2::uuid
		FOR UPDATE`, taskID, employeeID).Scan(&version, &status, &agent, &nodeID, &queueExpires, &execSeconds)
	if err != nil {
		return fmt.Errorf("保存准备失败: %s", redact.Scrub(err.Error()))
	}
	var preparedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT prepared_at
		FROM executions
		WHERE id = $1::uuid AND employee_id = $2::uuid AND task_id = $3::uuid
		FOR UPDATE`, executionID, employeeID, taskID).Scan(&preparedAt)
	if err != nil {
		return fmt.Errorf("保存准备失败: %s", redact.Scrub(err.Error()))
	}
	if preparedAt != nil {
		if err := ackOutbox(ctx, tx, fact.MessageID); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if status != task.StatusQueued {
		if err := ackOutbox(ctx, tx, fact.MessageID); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	fact.NodeID = nodeID
	if err := failLocked(ctx, tx, fact, version, agent, nodeID, queueExpires, execSeconds, code, message); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// FailUnsentPrepares 先退役无效投递，再把有明确未发送证据的过期任务标为等待超时。
func (s *Store) FailUnsentPrepares(ctx context.Context) error {
	if err := s.RetirePrepares(ctx); err != nil {
		return err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT o.id::text
		FROM dispatch_outbox o
		JOIN tasks t ON t.id = o.task_id AND t.employee_id = o.employee_id
		JOIN executions e ON e.id = o.execution_id AND e.employee_id = o.employee_id
		WHERE o.acked_at IS NULL
		  AND NOT o.may_have_been_sent
		  AND o.send_deadline <= now()
		  AND t.status = 'queued'
		  AND e.prepared_at IS NULL
		LIMIT 8`)
	if err != nil {
		return fmt.Errorf("检查未投递任务失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return fmt.Errorf("检查未投递任务失败: %s", redact.Scrub(err.Error()))
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("检查未投递任务失败: %s", redact.Scrub(err.Error()))
	}
	for _, id := range ids {
		if err := s.failPrepare(ctx, PreparedFact{MessageID: id}, task.CodeQueueTimeout, "排队等待已到期，任务尚未投递", true); err != nil {
			return err
		}
	}
	return nil
}

func failLocked(ctx context.Context, tx pgx.Tx, fact PreparedFact, version int, agent, nodeID string, queueExpires time.Time, execSeconds int, code, message string) error {
	if !allowedPrepareCode(code) {
		return errors.New("准备失败原因无效")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE tasks
		SET status = 'failed', error_code = $3, error_message = $4, version = version + 1, updated_at = now()
		WHERE id = $1::uuid AND employee_id = $2::uuid AND status = 'queued'`,
		fact.TaskID, fact.EmployeeID, code, message); err != nil {
		return fmt.Errorf("保存准备失败: %s", redact.Scrub(err.Error()))
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sessions
		SET bound_execution_id = NULL, updated_at = now()
		WHERE employee_id = $1::uuid AND bound_execution_id = $2::uuid`,
		fact.EmployeeID, fact.ExecutionID); err != nil {
		return fmt.Errorf("释放 Session 失败: %s", redact.Scrub(err.Error()))
	}
	eventID, err := identity.NewUUID()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_events (
			id, task_id, employee_id, version, actor_employee_id, kind,
			status, target_node_id, agent_type, queue_expires_at,
			execution_timeout_seconds, reason_code, created_at
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4, $3::uuid, 'failed',
			'failed', $5::uuid, $6, $7, $8, $9, now()
		)`, eventID, fact.TaskID, fact.EmployeeID, version+1, nodeID, agent, queueExpires, execSeconds, code); err != nil {
		return fmt.Errorf("保存准备失败: %s", redact.Scrub(err.Error()))
	}
	if err := enqueueTaskTerminal(ctx, tx, fact.EmployeeID, fact.TaskID); err != nil {
		return err
	}
	return ackOutbox(ctx, tx, fact.MessageID)
}

func ackOutbox(ctx context.Context, tx pgx.Tx, messageID string) error {
	tag, err := tx.Exec(ctx, `
		UPDATE dispatch_outbox
		SET acked_at = now()
		WHERE id = $1::uuid AND acked_at IS NULL`, messageID)
	if err != nil {
		return fmt.Errorf("确认投递失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() != 1 {
		return errors.New("投递已经被确认")
	}
	return nil
}

func checkFact(fact PreparedFact) error {
	for _, id := range []string{fact.MessageID, fact.EmployeeID, fact.NodeID, fact.TaskID, fact.ExecutionID, fact.SessionID} {
		if _, err := identity.ParseUUID(id); err != nil {
			return errors.New("准备结果标识不正确")
		}
	}
	if fact.StorageGeneration == "" || len(fact.StorageGeneration) > 80 {
		return errors.New("存储代次不正确")
	}
	return nil
}

func allowedPrepareCode(code string) bool {
	switch code {
	case task.CodeSessionBusy, task.CodeUnsupported, task.CodeInvalidTarget, task.CodeQueueTimeout, task.CodeUnavailable, task.CodeArtifactUnavailable:
		return true
	default:
		return false
	}
}
