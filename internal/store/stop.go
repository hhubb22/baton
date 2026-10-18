package store

import (
	"context"
	"time"

	"baton/internal/identity"
	"baton/internal/task"
	"github.com/jackc/pgx/v5"
)

func requestStop(ctx context.Context, tx pgx.Tx, executionID, reason string) error {
	_, err := tx.Exec(ctx, `INSERT INTO execution_stops (execution_id, reason, requested_at)
 VALUES ($1::uuid, $2, now()) ON CONFLICT (execution_id) DO NOTHING`, executionID, reason)
	return err
}

// ExecutionControl 只返回这次执行的控制信息，不能据中心旧状态重放输入。
func (s *Store) ExecutionControl(ctx context.Context, employeeID, nodeID, taskID, executionID, sessionID string) (string, int, error) {
	for _, id := range []string{employeeID, nodeID, taskID, executionID, sessionID} {
		if _, err := identity.ParseUUID(id); err != nil {
			return "", 0, ErrNotVisible
		}
	}
	var reason string
	var seconds int
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(x.reason, CASE WHEN t.cancel_requested_at IS NOT NULL THEN 'cancelled'
 WHEN t.execution_expires_at <= now() THEN 'execution_timeout'
 WHEN e.started_at IS NULL AND t.queue_expires_at <= now() THEN 'queue_timeout' ELSE '' END), t.execution_timeout_seconds
 FROM tasks t JOIN executions e ON e.task_id = t.id
 LEFT JOIN execution_stops x ON x.execution_id = e.id
 WHERE t.employee_id = $1::uuid AND t.target_node_id = $2::uuid AND t.id = $3::uuid
 AND e.id = $4::uuid AND t.target_session_id = $5::uuid`, employeeID, nodeID, taskID, executionID, sessionID).Scan(&reason, &seconds)
	return reason, seconds, err
}

// ExpireExecutionsAt 的时钟由调用方提供，便于在不等待真实期限的情况下验证边界。
func (s *Store) ExpireExecutionsAt(ctx context.Context, now time.Time) error {
	rows, err := s.pool.Query(ctx, `SELECT id::text, employee_id::text FROM tasks
 WHERE execution_expires_at <= $1 AND status IN ('queued', 'running', 'needs_verification')
 AND NOT EXISTS (SELECT 1 FROM executions e JOIN execution_stops x ON x.execution_id = e.id WHERE e.task_id = tasks.id)
 ORDER BY execution_expires_at LIMIT 32`, now)
	if err != nil {
		return err
	}
	type key struct{ taskID, employeeID string }
	var keys []key
	for rows.Next() {
		var k key
		if err := rows.Scan(&k.taskID, &k.employeeID); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, k)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, k := range keys {
		if err := s.expireExecution(ctx, k.employeeID, k.taskID, now); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) expireExecution(ctx context.Context, employeeID, taskID string, now time.Time) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	row, exec, err := lockCancel(ctx, tx, employeeID, taskID)
	if err != nil {
		return err
	}
	var expired bool
	if err := tx.QueryRow(ctx, `SELECT COALESCE(execution_expires_at <= $2, false) FROM tasks WHERE id = $1::uuid`, taskID, now).Scan(&expired); err != nil {
		return err
	}
	var stopping bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM execution_stops WHERE execution_id = $1::uuid)`, exec.id).Scan(&stopping); err != nil {
		return err
	}
	if expired && !stopping && (row.status == task.StatusQueued || row.status == task.StatusRunning || row.status == task.StatusNeedsVerification) {
		if err := requestStop(ctx, tx, exec.id, task.CodeExecutionTimeout); err != nil {
			return err
		}
		if err := bumpTask(ctx, tx, employeeID, taskID, row.version, task.StatusNeedsVerification, task.CodeExecutionTimeout, "执行期限已到，中止及操作结果待确认"); err != nil {
			return err
		}
		if err := insertStartEvent(ctx, tx, employeeID, taskID, row, "stop_requested", task.StatusNeedsVerification, task.CodeExecutionTimeout); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func applyStopReport(ctx context.Context, tx pgx.Tx, in ExecutionReport, head executionHead) error {
	if err := requestStop(ctx, tx, in.ExecutionID, in.StopReason); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE execution_stops SET acknowledged_at = COALESCE(acknowledged_at, now()),
 stopped_at = CASE WHEN $2 THEN COALESCE(stopped_at, $3) ELSE stopped_at END,
 outcome_known = outcome_known OR $4, not_started = not_started OR $5
 WHERE execution_id = $1::uuid`, in.ExecutionID, in.AgentStopped, in.OccurredAt, in.OutcomeKnown, in.NotStarted)
	if err != nil {
		return err
	}
	status, code, message := task.StatusNeedsVerification, in.StopReason, "已请求中止，停止或操作结果仍待核实；停止不回滚外部副作用"
	if code == task.StatusCancelled {
		code = ""
	}
	if in.AgentStopped && in.OutcomeKnown {
		if in.StopReason == task.StatusCancelled {
			status = task.StatusCancelled
		} else {
			status = task.StatusFailed
		}
		message = "已确认停止；不会回滚已经发生的外部副作用"
	}
	if head.status == task.StatusCompleted || head.status == task.StatusFailed || head.status == task.StatusCancelled {
		status, code = head.status, ""
		if err := bumpVersion(ctx, tx, in.EmployeeID, in.TaskID, head.version); err != nil {
			return err
		}
	} else {
		if err := bumpTask(ctx, tx, in.EmployeeID, in.TaskID, head.version, status, code, message); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE tasks SET summary = $2 WHERE id = $1::uuid`, in.TaskID, message); err != nil {
			return err
		}
		sessionStatus := "unknown"
		if in.AgentStopped {
			sessionStatus = "stopped"
		}
		if _, err := tx.Exec(ctx, `UPDATE sessions SET status = $2,
   bound_execution_id = CASE WHEN $3 THEN NULL ELSE bound_execution_id END, updated_at = now()
   WHERE id = $1::uuid AND employee_id = $4::uuid AND bound_execution_id = $5::uuid`, in.SessionID, sessionStatus, in.AgentStopped && in.OutcomeKnown, in.EmployeeID, in.ExecutionID); err != nil {
			return err
		}
	}
	if err := insertReportEvent(ctx, tx, in, head, head.version+1, task.EventStopReport, status, code); err != nil {
		return err
	}
	return nil
}

func validStopReport(in ExecutionReport) bool {
	if in.Status != task.StatusNeedsVerification || in.OccurredAt.IsZero() || (in.OutcomeKnown && !in.AgentStopped) || (in.NotStarted && (!in.AgentStopped || !in.OutcomeKnown)) {
		return false
	}
	switch in.StopReason {
	case task.StatusCancelled, task.CodeQueueTimeout, task.CodeExecutionTimeout:
		return true
	}
	return false
}

func reportTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC()
}
