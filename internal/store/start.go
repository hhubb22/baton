package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"baton/internal/identity"
	"baton/internal/redact"
	"baton/internal/startpermit"
	"baton/internal/task"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// StartRequest 是节点为已准备的执行申请启动许可。
type StartRequest struct {
	EmployeeID        string
	NodeID            string
	CredentialID      string
	TaskID            string
	ExecutionID       string
	SessionID         string
	StorageGeneration string
	Nonce             string
}

// StartDecision 是授权事务的结果。只有 Issue 为 true 且没有错误时才能签名。
type StartDecision struct {
	Issue         bool
	PossibleStart bool
	Code          string
	Message       string
	Claims        startpermit.Claims
}

// CancelDecision 是取消事务的结果。PossibleStart 为 true 时不能把任务说成未执行。
type CancelDecision struct {
	TaskID        string
	Status        string
	PossibleStart bool
	Version       int
}

type lockedTask struct {
	version      int
	status       string
	agent        string
	nodeID       string
	sessionID    *string
	queueExpires time.Time
	execSeconds  int
	cancelAt     *time.Time
	requestHash  []byte
	errorCode    *string
}

type lockedExec struct {
	id            string
	nodeID        string
	generation    *string
	preparedAt    *time.Time
	authorizedAt  *time.Time
	permitExpires *time.Time
	refusedAt     *time.Time
	nonce         *string
}

// AuthorizeStart 在一个事务里重新检查任务、取消、吊销、排队期限和执行身份。
// 写入 start_authorized 并提交成功后，Issue 才为 true。提交失败时不会要求签发许可。
func (s *Store) AuthorizeStart(ctx context.Context, in StartRequest) (StartDecision, error) {
	if err := checkStartRequest(in); err != nil {
		return StartDecision{Code: task.CodeInvalidTarget, Message: "启动许可请求无效"}, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return StartDecision{}, fmt.Errorf("签发启动许可失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row, exec, revoked, err := lockStart(ctx, tx, in)
	if err != nil {
		return StartDecision{}, err
	}
	if row.status == "" {
		return StartDecision{Code: task.CodeInvalidTarget, Message: "任务不存在或不能启动"}, nil
	}
	decision, write, err := decideStart(ctx, tx, in, row, exec, revoked)
	if err != nil {
		return StartDecision{}, err
	}
	if decision.Issue && write {
		if err := s.runStartHook(ctx); err != nil {
			return StartDecision{}, err
		}
	}
	if write || decision.Issue {
		if err := tx.Commit(ctx); err != nil {
			return StartDecision{}, fmt.Errorf("签发启动许可失败: %s", redact.Scrub(err.Error()))
		}
	}
	return decision, nil
}

// RequestCancel 保存取消请求。尚未发出启动许可时可以直接取消；
// 许可已经发出且没有明确的未启动证据时，只记录可能已启动，不把任务标成未执行。
func (s *Store) RequestCancel(ctx context.Context, employeeID, taskID string) (CancelDecision, error) {
	var err error
	employeeID, err = identity.ParseUUID(employeeID)
	if err != nil {
		return CancelDecision{}, ErrNotVisible
	}
	taskID, err = identity.ParseUUID(taskID)
	if err != nil {
		return CancelDecision{}, errors.New("任务标识不正确")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CancelDecision{}, fmt.Errorf("保存取消失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, exec, err := lockCancel(ctx, tx, employeeID, taskID)
	if err != nil {
		return CancelDecision{}, err
	}
	if row.status == "" {
		return CancelDecision{}, ErrNotVisible
	}
	decision, write, err := applyCancel(ctx, tx, employeeID, taskID, row, exec)
	if err != nil {
		return CancelDecision{}, err
	}
	if write {
		if err := s.runCancelHook(ctx); err != nil {
			return CancelDecision{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return CancelDecision{}, fmt.Errorf("保存取消失败: %s", redact.Scrub(err.Error()))
	}
	return decision, nil
}

// RecordStartRefusal 记录节点在写入 start_intent 之前拒绝启动。
// 没有这张回执时，不能据此把已授权的任务说成未执行。
func (s *Store) RecordStartRefusal(ctx context.Context, employeeID, nodeID, taskID, executionID string) error {
	for _, id := range []string{employeeID, nodeID, taskID, executionID} {
		if _, err := identity.ParseUUID(id); err != nil {
			return errors.New("启动拒绝标识不正确")
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("保存启动拒绝失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, exec, err := lockCancel(ctx, tx, employeeID, taskID)
	if err != nil {
		return err
	}
	if row.status == "" || exec.nodeID != nodeID || exec.id != executionID || exec.authorizedAt == nil {
		return tx.Commit(ctx)
	}
	if exec.refusedAt == nil {
		tag, err := tx.Exec(ctx, `
			UPDATE executions
			SET start_refused_at = now()
			WHERE id = $1::uuid AND employee_id = $2::uuid AND start_authorized_at IS NOT NULL
			  AND start_refused_at IS NULL`, executionID, employeeID)
		if err != nil {
			return fmt.Errorf("保存启动拒绝失败: %s", redact.Scrub(err.Error()))
		}
		if tag.RowsAffected() == 1 && row.cancelAt != nil && row.status == task.StatusNeedsVerification {
			if err := finishNotStarted(ctx, tx, employeeID, taskID, executionID, row, task.StatusCancelled, "", ""); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

// ExpireQueuedTasks 处理排队期限已到的任务。能确认尚未启动的标为等待超时；
// 许可已经发出但没有未启动证据的，改为待核实，不标成未执行。
func (s *Store) ExpireQueuedTasks(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `
		SELECT t.id::text
		FROM tasks t
		JOIN executions e ON e.task_id = t.id AND e.employee_id = t.employee_id
		WHERE t.status = 'queued'
		  AND t.queue_expires_at <= now()
		  AND e.prepared_at IS NOT NULL
		LIMIT 8`)
	if err != nil {
		return fmt.Errorf("检查排队期限失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return fmt.Errorf("检查排队期限失败: %s", redact.Scrub(err.Error()))
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("检查排队期限失败: %s", redact.Scrub(err.Error()))
	}
	for _, id := range ids {
		if err := s.expireOne(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) expireOne(ctx context.Context, taskID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("检查排队期限失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var employeeID string
	err = tx.QueryRow(ctx, `
		SELECT employee_id::text FROM tasks WHERE id = $1::uuid FOR UPDATE`, taskID).Scan(&employeeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("检查排队期限失败: %s", redact.Scrub(err.Error()))
	}
	row, exec, err := lockCancel(ctx, tx, employeeID, taskID)
	if err != nil {
		return err
	}
	var expired bool
	if err := tx.QueryRow(ctx, `SELECT queue_expires_at <= now() FROM tasks WHERE id = $1::uuid`, taskID).Scan(&expired); err != nil {
		return fmt.Errorf("检查排队期限失败: %s", redact.Scrub(err.Error()))
	}
	if row.status != task.StatusQueued || !expired || exec.preparedAt == nil {
		return tx.Commit(ctx)
	}
	if exec.authorizedAt != nil && exec.refusedAt == nil {
		if err := markUncertain(ctx, tx, employeeID, taskID, row); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if err := finishNotStarted(ctx, tx, employeeID, taskID, exec.id, row, task.StatusFailed, task.CodeQueueTimeout, "排队等待已到期，任务尚未启动"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func decideStart(ctx context.Context, tx pgx.Tx, in StartRequest, row lockedTask, exec lockedExec, revoked bool) (StartDecision, bool, error) {
	if row.status == task.StatusCancelled {
		return StartDecision{Code: task.StatusCancelled, Message: "任务已取消", PossibleStart: false}, false, nil
	}
	if row.status == task.StatusFailed || row.status == task.StatusCompleted {
		code := task.CodeInvalidTarget
		if row.errorCode != nil && *row.errorCode != "" {
			code = *row.errorCode
		}
		return StartDecision{Code: code, Message: "任务已经结束", PossibleStart: false}, false, nil
	}
	if row.status == task.StatusNeedsVerification {
		return StartDecision{Code: task.CodeConflict, Message: "任务是否已经启动还不能确定", PossibleStart: true}, false, nil
	}
	if row.status != task.StatusQueued || exec.nodeID != in.NodeID || row.nodeID != in.NodeID {
		return StartDecision{Code: task.CodeInvalidTarget, Message: "任务不存在或不能启动"}, false, nil
	}
	if exec.preparedAt == nil {
		return StartDecision{Code: task.CodeUnavailable, Message: "准备事实尚未保存"}, false, nil
	}
	if exec.generation == nil || *exec.generation != in.StorageGeneration || row.sessionID == nil || *row.sessionID != in.SessionID {
		return StartDecision{Code: task.CodeInvalidTarget, Message: "执行身份或存储代次不匹配"}, false, nil
	}
	possible := exec.authorizedAt != nil && exec.refusedAt == nil
	if row.cancelAt != nil {
		decision, err := cancelLocked(ctx, tx, in.EmployeeID, in.TaskID, in.ExecutionID, row, exec)
		return decision, true, err
	}
	if revoked {
		if possible {
			if err := markUncertain(ctx, tx, in.EmployeeID, in.TaskID, row); err != nil {
				return StartDecision{}, false, err
			}
			return StartDecision{Code: task.CodeRevoked, Message: "节点凭据已吊销，不能确认任务尚未启动", PossibleStart: true}, true, nil
		}
		if err := finishNotStarted(ctx, tx, in.EmployeeID, in.TaskID, in.ExecutionID, row, task.StatusFailed, task.CodeRevoked, "节点凭据已吊销，任务尚未启动"); err != nil {
			return StartDecision{}, false, err
		}
		return StartDecision{Code: task.CodeRevoked, Message: "节点凭据已吊销，任务尚未启动"}, true, nil
	}
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT now()`).Scan(&now); err != nil {
		return StartDecision{}, false, fmt.Errorf("签发启动许可失败: %s", redact.Scrub(err.Error()))
	}
	now = now.UTC().Truncate(time.Millisecond)
	rawQueue := row.queueExpires.UTC()
	queueExpires := rawQueue.Truncate(time.Millisecond)
	if !queueExpires.After(now) {
		if possible {
			if err := markUncertain(ctx, tx, in.EmployeeID, in.TaskID, row); err != nil {
				return StartDecision{}, false, err
			}
			return StartDecision{Code: task.CodeQueueTimeout, Message: "排队等待已到期，不能确认任务尚未启动", PossibleStart: true}, true, nil
		}
		if err := finishNotStarted(ctx, tx, in.EmployeeID, in.TaskID, in.ExecutionID, row, task.StatusFailed, task.CodeQueueTimeout, "排队等待已到期，任务尚未启动"); err != nil {
			return StartDecision{}, false, err
		}
		return StartDecision{Code: task.CodeQueueTimeout, Message: "排队等待已到期，任务尚未启动"}, true, nil
	}
	if exec.authorizedAt != nil {
		if exec.nonce != nil && *exec.nonce == in.Nonce && exec.refusedAt == nil && exec.permitExpires != nil && exec.permitExpires.After(now) {
			claims := startpermit.Claims{
				NodeID: in.NodeID, EmployeeID: in.EmployeeID, TaskID: in.TaskID, ExecutionID: in.ExecutionID,
				StorageGeneration: in.StorageGeneration, Nonce: in.Nonce, RequestHash: append([]byte(nil), row.requestHash...),
				QueueExpiresAt: rawQueue, IssuedAt: exec.authorizedAt.UTC().Truncate(time.Millisecond),
				ExpiresAt: exec.permitExpires.UTC().Truncate(time.Millisecond),
			}
			return StartDecision{Issue: true, PossibleStart: true, Claims: claims}, false, nil
		}
		return StartDecision{Code: task.CodeConflict, Message: "启动许可已经发出", PossibleStart: possible}, false, nil
	}
	lifetime := queueExpires.Sub(now)
	if lifetime > startpermit.PermitTTL {
		lifetime = startpermit.PermitTTL
	}
	if lifetime <= startpermit.SafetyMargin {
		if err := finishNotStarted(ctx, tx, in.EmployeeID, in.TaskID, in.ExecutionID, row, task.StatusFailed, task.CodeQueueTimeout, "排队剩余时间不足以启动"); err != nil {
			return StartDecision{}, false, err
		}
		return StartDecision{Code: task.CodeQueueTimeout, Message: "排队剩余时间不足以启动"}, true, nil
	}
	expires := now.Add(lifetime)
	tag, err := tx.Exec(ctx, `
		UPDATE executions
		SET start_authorized_at = $3, start_permit_expires_at = $4, permit_nonce = $5
		WHERE id = $1::uuid AND employee_id = $2::uuid AND start_authorized_at IS NULL`,
		in.ExecutionID, in.EmployeeID, now, expires, in.Nonce)
	if err != nil {
		return StartDecision{}, false, fmt.Errorf("签发启动许可失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() != 1 {
		return StartDecision{Code: task.CodeConflict, Message: "启动许可已经发出", PossibleStart: true}, false, nil
	}
	if err := bumpTask(ctx, tx, in.EmployeeID, in.TaskID, row.version, task.StatusQueued, "", ""); err != nil {
		return StartDecision{}, false, err
	}
	if err := insertStartEvent(ctx, tx, in.EmployeeID, in.TaskID, row, task.EventStartAuthorized, task.StatusQueued, ""); err != nil {
		return StartDecision{}, false, err
	}
	claims := startpermit.Claims{
		NodeID: in.NodeID, EmployeeID: in.EmployeeID, TaskID: in.TaskID, ExecutionID: in.ExecutionID,
		StorageGeneration: in.StorageGeneration, Nonce: in.Nonce, RequestHash: append([]byte(nil), row.requestHash...),
		QueueExpiresAt: rawQueue, IssuedAt: now, ExpiresAt: expires,
	}
	return StartDecision{Issue: true, PossibleStart: true, Claims: claims}, true, nil
}

func applyCancel(ctx context.Context, tx pgx.Tx, employeeID, taskID string, row lockedTask, exec lockedExec) (CancelDecision, bool, error) {
	switch row.status {
	case task.StatusCancelled, task.StatusFailed, task.StatusCompleted:
		return CancelDecision{TaskID: taskID, Status: row.status, Version: row.version}, false, nil
	case task.StatusNeedsVerification:
		if !possibleStart(row, exec) {
			if err := finishNotStarted(ctx, tx, employeeID, taskID, exec.id, row, task.StatusCancelled, "", ""); err != nil {
				return CancelDecision{}, false, err
			}
			return CancelDecision{TaskID: taskID, Status: task.StatusCancelled, Version: row.version + 1}, true, nil
		}
		if row.cancelAt == nil {
			if _, err := tx.Exec(ctx, `
				UPDATE tasks
				SET cancel_requested_at = now()
				WHERE id = $1::uuid AND employee_id = $2::uuid AND cancel_requested_at IS NULL`,
				taskID, employeeID); err != nil {
				return CancelDecision{}, false, fmt.Errorf("保存取消失败: %s", redact.Scrub(err.Error()))
			}
		}
		return CancelDecision{TaskID: taskID, Status: row.status, Version: row.version, PossibleStart: true}, row.cancelAt == nil, nil
	}
	if row.status != task.StatusQueued && row.status != task.StatusRunning {
		return CancelDecision{TaskID: taskID, Status: row.status, Version: row.version}, false, nil
	}
	start, err := cancelLocked(ctx, tx, employeeID, taskID, exec.id, row, exec)
	if err != nil {
		return CancelDecision{}, false, err
	}
	decision := CancelDecision{TaskID: taskID, Version: row.version + 1, PossibleStart: start.PossibleStart}
	if start.PossibleStart {
		decision.Status = task.StatusNeedsVerification
		return decision, true, nil
	}
	decision.Status = task.StatusCancelled
	return decision, true, nil
}

func cancelLocked(ctx context.Context, tx pgx.Tx, employeeID, taskID, executionID string, row lockedTask, exec lockedExec) (StartDecision, error) {
	if _, err := tx.Exec(ctx, `
		UPDATE tasks
		SET cancel_requested_at = COALESCE(cancel_requested_at, now())
		WHERE id = $1::uuid AND employee_id = $2::uuid`, taskID, employeeID); err != nil {
		return StartDecision{}, fmt.Errorf("保存取消失败: %s", redact.Scrub(err.Error()))
	}
	if possibleStart(row, exec) {
		if err := markUncertain(ctx, tx, employeeID, taskID, row); err != nil {
			return StartDecision{}, err
		}
		return StartDecision{Code: task.CodeConflict, Message: "启动许可可能已经生效", PossibleStart: true}, nil
	}
	if err := finishNotStarted(ctx, tx, employeeID, taskID, executionID, row, task.StatusCancelled, "", ""); err != nil {
		return StartDecision{}, err
	}
	return StartDecision{Code: task.StatusCancelled, Message: "任务已取消"}, nil
}

func possibleStart(row lockedTask, exec lockedExec) bool {
	if exec.authorizedAt == nil || exec.refusedAt != nil {
		return false
	}
	switch row.status {
	case task.StatusCancelled, task.StatusFailed, task.StatusCompleted:
		return false
	default:
		return true
	}
}

func markUncertain(ctx context.Context, tx pgx.Tx, employeeID, taskID string, row lockedTask) error {
	if row.status == task.StatusNeedsVerification {
		return nil
	}
	if err := bumpTask(ctx, tx, employeeID, taskID, row.version, task.StatusNeedsVerification, "", ""); err != nil {
		return err
	}
	return insertStartEvent(ctx, tx, employeeID, taskID, row, task.EventNeedsVerification, task.StatusNeedsVerification, "")
}

func finishNotStarted(ctx context.Context, tx pgx.Tx, employeeID, taskID, executionID string, row lockedTask, status, code, message string) error {
	if status != task.StatusCancelled && status != task.StatusFailed {
		return errors.New("任务结束状态无效")
	}
	if err := bumpTask(ctx, tx, employeeID, taskID, row.version, status, code, message); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sessions
		SET bound_execution_id = NULL, updated_at = now()
		WHERE employee_id = $1::uuid AND bound_execution_id = $2::uuid`, employeeID, executionID); err != nil {
		return fmt.Errorf("释放 Session 失败: %s", redact.Scrub(err.Error()))
	}
	kind := task.EventCancelled
	if status == task.StatusFailed {
		kind = task.EventFailed
	}
	return insertStartEvent(ctx, tx, employeeID, taskID, row, kind, status, code)
}

func bumpTask(ctx context.Context, tx pgx.Tx, employeeID, taskID string, version int, status, code, message string) error {
	var err error
	var tag pgconn.CommandTag
	if code == "" {
		tag, err = tx.Exec(ctx, `
			UPDATE tasks
			SET status = $3, error_code = NULL, error_message = NULL,
			    version = version + 1, updated_at = now()
			WHERE id = $1::uuid AND employee_id = $2::uuid AND version = $4`,
			taskID, employeeID, status, version)
	} else {
		tag, err = tx.Exec(ctx, `
			UPDATE tasks
			SET status = $3, error_code = $4, error_message = $5,
			    version = version + 1, updated_at = now()
			WHERE id = $1::uuid AND employee_id = $2::uuid AND version = $6`,
			taskID, employeeID, status, code, message, version)
	}
	if err != nil {
		return fmt.Errorf("更新任务失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() != 1 {
		return errors.New("任务版本已变化")
	}
	return nil
}

func insertStartEvent(ctx context.Context, tx pgx.Tx, employeeID, taskID string, row lockedTask, kind, status, reason string) error {
	eventID, err := identity.NewUUID()
	if err != nil {
		return err
	}
	var reasonArg any
	if reason != "" {
		reasonArg = reason
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO task_events (
			id, task_id, employee_id, version, actor_employee_id, kind,
			status, target_node_id, agent_type, queue_expires_at,
			execution_timeout_seconds, reason_code, created_at
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4, $3::uuid, $5,
			$6, $7::uuid, $8, $9, $10, $11, now()
		)`, eventID, taskID, employeeID, row.version+1, kind, status, row.nodeID, row.agent,
		row.queueExpires, row.execSeconds, reasonArg)
	if err != nil {
		return fmt.Errorf("保存任务事件失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

func lockStart(ctx context.Context, tx pgx.Tx, in StartRequest) (lockedTask, lockedExec, bool, error) {
	row, err := lockTask(ctx, tx, in.EmployeeID, in.TaskID)
	if err != nil || row.status == "" {
		return row, lockedExec{}, false, err
	}
	exec, err := lockExec(ctx, tx, in.EmployeeID, in.TaskID, in.ExecutionID)
	if err != nil {
		return lockedTask{}, lockedExec{}, false, err
	}
	if exec.nodeID == "" {
		return lockedTask{}, lockedExec{}, false, nil
	}
	var nodeRevoked, credRevoked *time.Time
	err = tx.QueryRow(ctx, `
		SELECT n.revoked_at, c.revoked_at
		FROM nodes n
		LEFT JOIN node_credentials c
		  ON c.id = $3::uuid AND c.node_id = n.id AND c.employee_id = n.employee_id
		WHERE n.id = $1::uuid AND n.employee_id = $2::uuid
		FOR UPDATE OF n`, in.NodeID, in.EmployeeID, in.CredentialID).Scan(&nodeRevoked, &credRevoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return lockedTask{}, lockedExec{}, false, nil
	}
	if err != nil {
		return lockedTask{}, lockedExec{}, false, fmt.Errorf("读取节点失败: %s", redact.Scrub(err.Error()))
	}
	return row, exec, nodeRevoked != nil || credRevoked != nil, nil
}

func lockCancel(ctx context.Context, tx pgx.Tx, employeeID, taskID string) (lockedTask, lockedExec, error) {
	row, err := lockTask(ctx, tx, employeeID, taskID)
	if err != nil || row.status == "" {
		return row, lockedExec{}, err
	}
	var executionID string
	err = tx.QueryRow(ctx, `
		SELECT id::text FROM executions
		WHERE task_id = $1::uuid AND employee_id = $2::uuid`, taskID, employeeID).Scan(&executionID)
	if err != nil {
		return lockedTask{}, lockedExec{}, fmt.Errorf("读取执行失败: %s", redact.Scrub(err.Error()))
	}
	exec, err := lockExec(ctx, tx, employeeID, taskID, executionID)
	return row, exec, err
}

func lockTask(ctx context.Context, tx pgx.Tx, employeeID, taskID string) (lockedTask, error) {
	var row lockedTask
	err := tx.QueryRow(ctx, `
		SELECT version, status, agent_type, target_node_id::text, target_session_id::text,
		       queue_expires_at, execution_timeout_seconds, cancel_requested_at,
		       request_hash, error_code
		FROM tasks
		WHERE id = $1::uuid AND employee_id = $2::uuid
		FOR UPDATE`, taskID, employeeID).Scan(
		&row.version, &row.status, &row.agent, &row.nodeID, &row.sessionID,
		&row.queueExpires, &row.execSeconds, &row.cancelAt, &row.requestHash, &row.errorCode,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return lockedTask{}, nil
	}
	if err != nil {
		return lockedTask{}, fmt.Errorf("读取任务失败: %s", redact.Scrub(err.Error()))
	}
	row.queueExpires = row.queueExpires.UTC()
	return row, nil
}

func lockExec(ctx context.Context, tx pgx.Tx, employeeID, taskID, executionID string) (lockedExec, error) {
	var exec lockedExec
	exec.id = executionID
	err := tx.QueryRow(ctx, `
		SELECT target_node_id::text, storage_generation, prepared_at,
		       start_authorized_at, start_permit_expires_at, start_refused_at, permit_nonce
		FROM executions
		WHERE id = $1::uuid AND employee_id = $2::uuid AND task_id = $3::uuid
		FOR UPDATE`, executionID, employeeID, taskID).Scan(
		&exec.nodeID, &exec.generation, &exec.preparedAt,
		&exec.authorizedAt, &exec.permitExpires, &exec.refusedAt, &exec.nonce,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return lockedExec{}, nil
	}
	if err != nil {
		return lockedExec{}, fmt.Errorf("读取执行失败: %s", redact.Scrub(err.Error()))
	}
	return exec, nil
}

func checkStartRequest(in StartRequest) error {
	for _, id := range []string{in.EmployeeID, in.NodeID, in.CredentialID, in.TaskID, in.ExecutionID, in.SessionID, in.Nonce} {
		if _, err := identity.ParseUUID(id); err != nil {
			return err
		}
	}
	if len(in.StorageGeneration) < 1 || len(in.StorageGeneration) > 80 {
		return errors.New("存储代次不正确")
	}
	return nil
}
