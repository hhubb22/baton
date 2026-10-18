package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"baton/internal/identity"
	"baton/internal/redact"
	"baton/internal/task"

	"github.com/jackc/pgx/v5"
)

// PrepareIntent 是一条可以重发的 prepare。MessageID 在整个重发过程中保持不变。
type PrepareIntent struct {
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

// ClaimPrepare 领取一条可以发送的 prepare，并写上租约。没有可投递的记录时 ok 为 false。
// 尚未交给 Relay 的消息只在 send_deadline 之前领取。已经交出但还没有确定结果的消息，过期后仍按租约重发。
func (s *Store) ClaimPrepare(ctx context.Context, lease time.Duration) (PrepareIntent, bool, error) {
	if lease <= 0 {
		return PrepareIntent{}, false, errors.New("租约无效")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PrepareIntent{}, false, fmt.Errorf("领取投递失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var intent PrepareIntent
	var targetSession, directory, generation *string
	err = tx.QueryRow(ctx, `
		SELECT o.id::text, o.employee_id::text, o.task_id::text, o.execution_id::text, o.target_node_id::text,
		       t.version, t.agent_type, t.target_session_id::text, t.working_directory, t.queue_expires_at,
		       e.storage_generation, t.required_artifacts
		FROM dispatch_outbox o
		JOIN tasks t ON t.id = o.task_id AND t.employee_id = o.employee_id
		JOIN executions e ON e.id = o.execution_id AND e.employee_id = o.employee_id
		JOIN node_presence p ON p.node_id = o.target_node_id AND p.employee_id = o.employee_id
		JOIN nodes n ON n.id = o.target_node_id AND n.employee_id = o.employee_id
		WHERE o.acked_at IS NULL
		  AND o.action = 'prepare'
		  AND (o.send_deadline > now() OR o.attempts > 0)
		  AND (o.lease_until IS NULL OR o.lease_until <= now())
		  AND t.status = 'queued'
		  AND e.prepared_at IS NULL
		  AND p.online
		  AND p.synced
		  AND n.revoked_at IS NULL
		ORDER BY o.created_at
		FOR UPDATE OF o SKIP LOCKED
		LIMIT 1`).Scan(
		&intent.MessageID, &intent.EmployeeID, &intent.TaskID, &intent.ExecutionID, &intent.NodeID,
		&intent.TaskVersion, &intent.AgentType, &targetSession, &directory, &intent.QueueExpiresAt,
		&generation, &intent.RequiredArtifacts,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return PrepareIntent{}, false, nil
	}
	if err != nil {
		return PrepareIntent{}, false, fmt.Errorf("领取投递失败: %s", redact.Scrub(err.Error()))
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
	seconds := int(lease / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	if _, err := tx.Exec(ctx, `
		UPDATE dispatch_outbox
		SET lease_until = now() + ($2::int * interval '1 second')
		WHERE id = $1::uuid AND acked_at IS NULL`, intent.MessageID, seconds); err != nil {
		return PrepareIntent{}, false, fmt.Errorf("领取投递失败: %s", redact.Scrub(err.Error()))
	}
	if err := tx.Commit(ctx); err != nil {
		return PrepareIntent{}, false, fmt.Errorf("领取投递失败: %s", redact.Scrub(err.Error()))
	}
	return intent, true, nil
}

// ReleasePrepare 提前结束租约，让同一条消息可以再次发送。
func (s *Store) ReleasePrepare(ctx context.Context, messageID string) error {
	if _, err := identity.ParseUUID(messageID); err != nil {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE dispatch_outbox
		SET lease_until = NULL
		WHERE id = $1::uuid AND acked_at IS NULL`, messageID)
	if err != nil {
		return fmt.Errorf("释放投递租约失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

// MarkPrepareSent 记录这条消息至少交给过 Relay 一次。之后不能再把它当成从未投递。
func (s *Store) MarkPrepareSent(ctx context.Context, messageID string) error {
	if _, err := identity.ParseUUID(messageID); err != nil {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE dispatch_outbox
		SET attempts = attempts + 1
		WHERE id = $1::uuid AND acked_at IS NULL`, messageID)
	if err != nil {
		return fmt.Errorf("记录投递次数失败: %s", redact.Scrub(err.Error()))
	}
	return nil
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
	if acked != nil {
		return tx.Commit(ctx)
	}
	if executionID != fact.ExecutionID || taskID != fact.TaskID || nodeID != fact.NodeID {
		return errors.New("准备结果与投递意图不一致")
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
	var executionID, taskID, employeeID string
	err = tx.QueryRow(ctx, `
		SELECT acked_at, execution_id::text, task_id::text, employee_id::text
		FROM dispatch_outbox
		WHERE id = $1::uuid
		FOR UPDATE`, fact.MessageID).Scan(&acked, &executionID, &taskID, &employeeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("找不到准备投递")
	}
	if err != nil {
		return fmt.Errorf("保存准备失败: %s", redact.Scrub(err.Error()))
	}
	if acked != nil {
		return tx.Commit(ctx)
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

// FailUnsentPrepares 把从未交给 Relay、并且排队期限已到的任务标为等待超时。
func (s *Store) FailUnsentPrepares(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `
		SELECT o.id::text
		FROM dispatch_outbox o
		JOIN tasks t ON t.id = o.task_id AND t.employee_id = o.employee_id
		JOIN executions e ON e.id = o.execution_id AND e.employee_id = o.employee_id
		WHERE o.acked_at IS NULL
		  AND o.attempts = 0
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
		if err := s.FailPrepare(ctx, PreparedFact{MessageID: id}, task.CodeQueueTimeout, "排队等待已到期，任务尚未投递"); err != nil {
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
