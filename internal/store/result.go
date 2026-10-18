package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"baton/internal/identity"
	"baton/internal/redact"
	"baton/internal/task"

	"github.com/jackc/pgx/v5"
)

// ExecutionReport 是节点上报、准备写入中心的执行事实。
type ExecutionReport struct {
	ExecutionElapsedMS   int64
	QueueDeadlineMet     bool
	WorkerSequence       int64
	OccurredAt           time.Time
	NotStarted           bool
	OutcomeKnown         bool
	StopReason           string
	EmployeeID           string
	NodeID               string
	EventID              string
	TaskID               string
	ExecutionID          string
	SessionID            string
	Kind                 string
	InputGeneration      int
	Status               string
	Summary              string
	Evidence             []task.ResultRef
	Artifacts            []task.ResultRef
	EvidenceEmptyReason  string
	ArtifactsEmptyReason string
	ErrorCode            string
	ErrorMessage         string
	AgentStopped         bool
}

// TaskInput 是同一次执行可以交给执行器的任务输入。
type TaskInput struct {
	Description        string
	AuthorizationScope *string
	ExpectedOutputs    *string
	WorkingDirectory   *string
	DeviceNames        []string
	Generation         int
}

type executionHead struct {
	version      int
	status       string
	agent        string
	nodeID       string
	sessionID    string
	sourceID     *string
	queueExpires any
	execSeconds  int
	authorized   bool
	refused      bool
	generation   *int
	errorCode    string
}

// LoadTaskInput 读取已经授权且尚未确认结束的执行输入。它不记录交付，也不启动执行。
func (s *Store) LoadTaskInput(ctx context.Context, employeeID, nodeID, taskID, executionID, sessionID string) (TaskInput, string, error) {
	for _, id := range []string{employeeID, nodeID, taskID, executionID, sessionID} {
		if _, err := identity.ParseUUID(id); err != nil {
			return TaskInput{}, task.CodeInvalidTarget, nil
		}
	}
	var out TaskInput
	var status string
	var authorized, refused bool
	var blocked bool
	err := s.pool.QueryRow(ctx, `
		SELECT t.description, t.authorization_scope, t.expected_outputs, t.working_directory,
		       t.device_names, t.status,
		       e.start_authorized_at IS NOT NULL, e.start_refused_at IS NOT NULL,
		       t.cancel_requested_at IS NOT NULL OR COALESCE(t.execution_expires_at <= now(), false)
		       OR (e.started_at IS NULL AND t.queue_expires_at <= now())
		       OR EXISTS (SELECT 1 FROM execution_stops x WHERE x.execution_id = e.id)
		FROM tasks t
		JOIN executions e ON e.task_id = t.id AND e.employee_id = t.employee_id
		WHERE t.employee_id = $1::uuid AND t.id = $2::uuid AND e.id = $3::uuid
		  AND t.target_node_id = $4::uuid AND t.target_session_id = $5::uuid`,
		employeeID, taskID, executionID, nodeID, sessionID).Scan(
		&out.Description, &out.AuthorizationScope, &out.ExpectedOutputs, &out.WorkingDirectory,
		&out.DeviceNames, &status, &authorized, &refused, &blocked,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return TaskInput{}, task.CodeInvalidTarget, nil
	}
	if err != nil {
		return TaskInput{}, "", fmt.Errorf("读取任务输入失败: %s", redact.Scrub(err.Error()))
	}
	switch status {
	case task.StatusQueued, task.StatusRunning, task.StatusNeedsVerification:
	default:
		return TaskInput{}, task.CodeConflict, nil
	}
	if !authorized || refused || strings.TrimSpace(out.Description) == "" {
		return TaskInput{}, task.CodeInvalidTarget, nil
	}
	if blocked {
		return TaskInput{}, task.CodeConflict, nil
	}
	out.Generation = 1
	if out.DeviceNames == nil {
		out.DeviceNames = []string{}
	}
	return out, "", nil
}

// ApplyExecutionReport 在一个事务里保存启动事实或结构化结果。
// 同一 event_id 重复上报不会产生第二份执行。调用方只有在返回 true 且 err 为 nil 时才能确认已交付。
func (s *Store) ApplyExecutionReport(ctx context.Context, in ExecutionReport) (bool, string, error) {
	if err := normalizeReport(&in); err != nil {
		return false, task.CodeInvalidTarget, nil
	}
	if in.Kind == task.EventStopReport {
		if !validStopReport(in) {
			return false, task.CodeInvalidTarget, nil
		}
	} else if in.Kind == task.EventResult {
		if err := task.ValidateCandidate(task.Candidate{
			Summary:              in.Summary,
			Evidence:             in.Evidence,
			Artifacts:            in.Artifacts,
			EvidenceEmptyReason:  in.EvidenceEmptyReason,
			ArtifactsEmptyReason: in.ArtifactsEmptyReason,
			ErrorCode:            in.ErrorCode,
			ErrorMessage:         in.ErrorMessage,
			Status:               in.Status,
		}); err != nil {
			return false, task.CodeResultFormat, nil
		}
		if in.Status == task.StatusCompleted && !in.AgentStopped {
			return false, task.CodeConflict, nil
		}
	} else if in.Kind == task.EventNeedsVerification {
		if in.Status != task.StatusNeedsVerification {
			return false, task.CodeInvalidTarget, nil
		}
	} else if in.Status != task.StatusRunning {
		return false, task.CodeInvalidTarget, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, "", fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var seenTask, seenKind string
	var seenExec *string
	err = tx.QueryRow(ctx, `
		SELECT task_id::text, kind, execution_id::text
		FROM task_events
		WHERE id = $1::uuid AND employee_id = $2::uuid`,
		in.EventID, in.EmployeeID).Scan(&seenTask, &seenKind, &seenExec)
	if err == nil {
		sameExec := seenExec == nil || *seenExec == "" || *seenExec == in.ExecutionID
		if seenTask != in.TaskID || seenKind != in.Kind || !sameExec {
			return false, task.CodeInvalidTarget, nil
		}
		if err := tx.Commit(ctx); err != nil {
			return false, "", fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
		}
		return true, "", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, "", fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	head, ok, err := lockExecution(ctx, tx, in)
	if err != nil {
		return false, "", err
	}
	if !ok {
		return false, task.CodeInvalidTarget, nil
	}
	if !head.authorized || head.refused || head.sessionID != in.SessionID || head.nodeID != in.NodeID {
		return false, task.CodeInvalidTarget, nil
	}
	if in.Kind != task.EventNeedsVerification && in.Kind != task.EventStopReport && head.generation != nil && *head.generation != in.InputGeneration {
		return false, task.CodeConflict, nil
	}
	if in.Kind == task.EventStopReport {
		err = applyStopReport(ctx, tx, in, head)
	} else if in.Kind == task.EventNeedsVerification {
		err = applyUncertain(ctx, tx, in, head)
	} else if in.Kind == task.EventStarted {
		err = applyStarted(ctx, tx, in, head)
	} else if head.status == task.StatusCompleted || head.status == task.StatusFailed || head.status == task.StatusCancelled {
		err = retainLateResult(ctx, tx, in, head)
	} else if in.Status == task.StatusCompleted {
		var blocked bool
		blocked, err = hasOpenChildren(ctx, tx, in.EmployeeID, in.TaskID)
		if err != nil {
			return false, "", err
		}
		if blocked {
			return false, "delegation_pending", nil
		}
		err = applyResult(ctx, tx, in, head)
	} else {
		err = applyResult(ctx, tx, in, head)
	}
	if err != nil {
		return false, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, "", fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	return true, "", nil
}

func applyUncertain(ctx context.Context, tx pgx.Tx, in ExecutionReport, head executionHead) error {
	switch head.status {
	case task.StatusCompleted, task.StatusFailed, task.StatusCancelled:
		return retainLateUncertain(ctx, tx, in, head)
	case task.StatusQueued, task.StatusRunning, task.StatusNeedsVerification:
	default:
		return nil
	}
	message, ok := task.UncertainMessage(in.ErrorCode)
	if !ok {
		return errors.New("待核实原因无效")
	}
	tag, err := tx.Exec(ctx, `
		UPDATE tasks
		SET status = 'needs_verification', error_code = $3, error_message = $4, version = version + 1, updated_at = now()
		WHERE id = $1::uuid AND employee_id = $2::uuid AND version = $5`,
		in.TaskID, in.EmployeeID, in.ErrorCode, message, head.version)
	if err != nil {
		return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() != 1 {
		return errors.New("任务版本已变化")
	}
	if err := insertReportEvent(ctx, tx, in, head, head.version+1, task.EventNeedsVerification, task.StatusNeedsVerification, in.ErrorCode); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sessions
		SET status = 'unknown', updated_at = now()
		WHERE employee_id = $1::uuid AND id = $2::uuid`,
		in.EmployeeID, in.SessionID); err != nil {
		return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

func applyStarted(ctx context.Context, tx pgx.Tx, in ExecutionReport, head executionHead) error {
	if in.ExecutionElapsedMS < 0 || in.ExecutionElapsedMS > int64(1<<31-1)*1000 {
		return errors.New("执行计时证据无效")
	}
	if _, err := tx.Exec(ctx, `UPDATE tasks SET execution_expires_at = COALESCE(execution_expires_at,
 now() + GREATEST(execution_timeout_seconds * 1000::bigint - $2::bigint, 0) * interval '1 millisecond') WHERE id = $1::uuid`, in.TaskID, in.ExecutionElapsedMS); err != nil {
		return err
	}
	if in.QueueDeadlineMet {
		if _, err := tx.Exec(ctx, `DELETE FROM execution_stops WHERE execution_id = $1::uuid AND reason = 'queue_timeout' AND acknowledged_at IS NULL`, in.ExecutionID); err != nil {
			return err
		}
	}
	var stopping bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM execution_stops WHERE execution_id = $1::uuid)`, in.ExecutionID).Scan(&stopping); err != nil {
		return err
	}
	if stopping {
		if _, err := tx.Exec(ctx, `UPDATE executions SET started_at = COALESCE(started_at, $2::timestamptz, now()), input_generation = COALESCE(input_generation, $3) WHERE id = $1::uuid`, in.ExecutionID, reportTime(in.OccurredAt), in.InputGeneration); err != nil {
			return err
		}
		if err := bumpVersion(ctx, tx, in.EmployeeID, in.TaskID, head.version); err != nil {
			return err
		}
		return insertReportEvent(ctx, tx, in, head, head.version+1, task.EventStarted, head.status, "")
	}
	if head.status == task.StatusNeedsVerification && task.IsUncertainCode(head.errorCode) {
		tag, err := tx.Exec(ctx, `
			UPDATE executions
			SET started_at = COALESCE(started_at, now()),
			    input_generation = COALESCE(input_generation, $3)
			WHERE id = $1::uuid AND employee_id = $2::uuid
			  AND start_authorized_at IS NOT NULL
			  AND (input_generation IS NULL OR input_generation = $3)`,
			in.ExecutionID, in.EmployeeID, in.InputGeneration)
		if err != nil {
			return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
		}
		if tag.RowsAffected() != 1 {
			return errors.New("执行代次不一致")
		}
		if err := bumpVersion(ctx, tx, in.EmployeeID, in.TaskID, head.version); err != nil {
			return err
		}
		return insertReportEvent(ctx, tx, in, head, head.version+1, task.EventStarted, task.StatusNeedsVerification, "")
	}
	if head.status != task.StatusQueued && head.status != task.StatusRunning && head.status != task.StatusNeedsVerification {
		return nil
	}
	tag, err := tx.Exec(ctx, `
		UPDATE executions
		SET started_at = COALESCE(started_at, now()),
		    input_generation = COALESCE(input_generation, $3)
		WHERE id = $1::uuid AND employee_id = $2::uuid
		  AND start_authorized_at IS NOT NULL
		  AND (input_generation IS NULL OR input_generation = $3)`,
		in.ExecutionID, in.EmployeeID, in.InputGeneration)
	if err != nil {
		return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() != 1 {
		return errors.New("执行代次不一致")
	}
	version := head.version
	if head.status != task.StatusRunning {
		tag, err = tx.Exec(ctx, `
			UPDATE tasks
			SET status = 'running', error_code = NULL, error_message = NULL,
			    version = version + 1, updated_at = now()
			WHERE id = $1::uuid AND employee_id = $2::uuid AND version = $3`,
			in.TaskID, in.EmployeeID, head.version)
		if err != nil {
			return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
		}
		if tag.RowsAffected() != 1 {
			return errors.New("任务版本已变化")
		}
		version++
		if err := insertReportEvent(ctx, tx, in, head, version, task.EventStarted, task.StatusRunning, ""); err != nil {
			return err
		}
	} else if err := insertReportEvent(ctx, tx, in, head, version+1, task.EventStarted, task.StatusRunning, ""); err != nil {
		return err
	} else if err := bumpVersion(ctx, tx, in.EmployeeID, in.TaskID, head.version); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		UPDATE sessions
		SET status = 'running', updated_at = now()
		WHERE employee_id = $1::uuid AND id = $2::uuid`,
		in.EmployeeID, in.SessionID)
	if err != nil {
		return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

func applyResult(ctx context.Context, tx pgx.Tx, in ExecutionReport, head executionHead) error {
	tag, err := tx.Exec(ctx, `
		UPDATE executions
		SET started_at = COALESCE(started_at, now()),
		    input_generation = COALESCE(input_generation, $3)
		WHERE id = $1::uuid AND employee_id = $2::uuid
		  AND start_authorized_at IS NOT NULL
		  AND (input_generation IS NULL OR input_generation = $3)`,
		in.ExecutionID, in.EmployeeID, in.InputGeneration)
	if err != nil {
		return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() != 1 {
		return errors.New("执行代次不一致")
	}
	tag, err = tx.Exec(ctx, `
		UPDATE tasks
		SET status = $3,
		    summary = $4,
		    evidence_empty_reason = $5,
		    artifacts_empty_reason = $6,
		    error_code = $7,
		    error_message = $8,
		    version = version + 1,
		    updated_at = now()
		WHERE id = $1::uuid AND employee_id = $2::uuid AND version = $9`,
		in.TaskID, in.EmployeeID, in.Status, nullText(in.Summary), nullText(in.EvidenceEmptyReason),
		nullText(in.ArtifactsEmptyReason), nullText(in.ErrorCode), nullText(in.ErrorMessage), head.version)
	if err != nil {
		return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() != 1 {
		return errors.New("任务版本已变化")
	}
	if err := replaceRefs(ctx, tx, in); err != nil {
		return err
	}
	if err := insertReportEvent(ctx, tx, in, head, head.version+1, task.EventResult, in.Status, in.ErrorCode); err != nil {
		return err
	}
	if err := insertDelivery(ctx, tx, in, head); err != nil {
		return err
	}
	sessionStatus := "stopped"
	if in.Status == task.StatusNeedsVerification {
		sessionStatus = "unknown"
	}
	if sessionStatus == "stopped" {
		_, err = tx.Exec(ctx, `
			UPDATE sessions
			SET status = 'stopped', bound_execution_id = NULL, updated_at = now()
			WHERE employee_id = $1::uuid AND id = $2::uuid
			  AND (bound_execution_id IS NULL OR bound_execution_id = $3::uuid)`,
			in.EmployeeID, in.SessionID, in.ExecutionID)
	} else {
		_, err = tx.Exec(ctx, `
			UPDATE sessions
			SET status = 'unknown', updated_at = now()
			WHERE employee_id = $1::uuid AND id = $2::uuid`,
			in.EmployeeID, in.SessionID)
	}
	if err != nil {
		return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

func retainLateResult(ctx context.Context, tx pgx.Tx, in ExecutionReport, head executionHead) error {
	if err := bumpVersion(ctx, tx, in.EmployeeID, in.TaskID, head.version); err != nil {
		return err
	}
	if err := insertReportEvent(ctx, tx, in, head, head.version+1, task.EventResult, in.Status, in.ErrorCode); err != nil {
		return err
	}
	if err := appendRefs(ctx, tx, in); err != nil {
		return err
	}
	return insertDelivery(ctx, tx, in, head)
}

func hasOpenChildren(ctx context.Context, tx pgx.Tx, employeeID, taskID string) (bool, error) {
	var blocked bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM tasks
			WHERE employee_id = $1::uuid AND parent_task_id = $2::uuid
			  AND status IN ('queued', 'running', 'needs_verification')
		)`, employeeID, taskID).Scan(&blocked)
	if err != nil {
		return false, fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	return blocked, nil
}

func lockExecution(ctx context.Context, tx pgx.Tx, in ExecutionReport) (executionHead, bool, error) {
	row, err := lockTask(ctx, tx, in.EmployeeID, in.TaskID)
	if err != nil || row.status == "" {
		return executionHead{}, false, err
	}
	var head executionHead
	var sessionID *string
	err = tx.QueryRow(ctx, `
		SELECT t.version, t.status, t.agent_type, t.target_node_id::text, t.target_session_id::text,
		       t.source_session_id::text, t.queue_expires_at, t.execution_timeout_seconds,
		       e.start_authorized_at IS NOT NULL, e.start_refused_at IS NOT NULL, e.input_generation,
		       COALESCE(t.error_code, '')
		FROM tasks t
		JOIN executions e ON e.task_id = t.id AND e.employee_id = t.employee_id
		WHERE t.id = $1::uuid AND t.employee_id = $2::uuid AND e.id = $3::uuid
		FOR UPDATE OF e`, in.TaskID, in.EmployeeID, in.ExecutionID).Scan(
		&head.version, &head.status, &head.agent, &head.nodeID, &sessionID,
		&head.sourceID, &head.queueExpires, &head.execSeconds,
		&head.authorized, &head.refused, &head.generation, &head.errorCode,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return executionHead{}, false, nil
	}
	if err != nil {
		return executionHead{}, false, fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	if sessionID != nil {
		head.sessionID = *sessionID
	}
	return head, true, nil
}

func insertReportEvent(ctx context.Context, tx pgx.Tx, in ExecutionReport, head executionHead, version int, kind, status, reason string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO task_events (
			id, task_id, employee_id, version, actor_employee_id, kind,
			status, target_node_id, agent_type, queue_expires_at,
			execution_timeout_seconds, reason_code, execution_id, created_at, occurred_at, agent_stopped, outcome_known, not_started, stop_reason, worker_sequence
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4, $3::uuid, $5,
			$6, $7::uuid, $8, $9, $10, $11, $12::uuid, now(), $13, $14, $15, $16, $17, $18
		)`, in.EventID, in.TaskID, in.EmployeeID, version, kind, status, head.nodeID, head.agent,
		head.queueExpires, head.execSeconds, nullText(reason), in.ExecutionID, reportTime(in.OccurredAt), in.AgentStopped, in.OutcomeKnown, in.NotStarted, nullText(in.StopReason), in.WorkerSequence)
	if err != nil {
		return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

func insertDelivery(ctx context.Context, tx pgx.Tx, in ExecutionReport, head executionHead) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO delivery_records (
			id, employee_id, task_id, execution_id, source_session_id, status, created_at
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'delivered', now()
		)`, in.EventID, in.EmployeeID, in.TaskID, in.ExecutionID, head.sourceID)
	if err != nil {
		return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

func replaceRefs(ctx context.Context, tx pgx.Tx, in ExecutionReport) error {
	if _, err := tx.Exec(ctx, `
		DELETE FROM task_result_refs
		WHERE employee_id = $1::uuid AND task_id = $2::uuid`, in.EmployeeID, in.TaskID); err != nil {
		return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	return insertRefs(ctx, tx, in, 0, 0)
}

func appendRefs(ctx context.Context, tx pgx.Tx, in ExecutionReport) error {
	var evidencePos, artifactPos int
	err := tx.QueryRow(ctx, `
		SELECT
			COALESCE(MAX(position) FILTER (WHERE kind = 'evidence'), -1) + 1,
			COALESCE(MAX(position) FILTER (WHERE kind = 'artifact'), -1) + 1
		FROM task_result_refs
		WHERE employee_id = $1::uuid AND task_id = $2::uuid`, in.EmployeeID, in.TaskID).Scan(&evidencePos, &artifactPos)
	if err != nil {
		return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	return insertRefs(ctx, tx, in, evidencePos, artifactPos)
}

func insertRefs(ctx context.Context, tx pgx.Tx, in ExecutionReport, evidencePos, artifactPos int) error {
	if err := insertRefKind(ctx, tx, in, "evidence", in.Evidence, evidencePos); err != nil {
		return err
	}
	return insertRefKind(ctx, tx, in, "artifact", in.Artifacts, artifactPos)
}

func insertRefKind(ctx context.Context, tx pgx.Tx, in ExecutionReport, kind string, refs []task.ResultRef, position int) error {
	for _, ref := range refs {
		id, err := identity.NewUUID()
		if err != nil {
			return err
		}
		var nodeID any
		if ref.NodeID != "" {
			nodeID = ref.NodeID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO task_result_refs (
				id, employee_id, task_id, execution_id, kind, position,
				node_id, storage_ref, resource_id, access_status, note
			) VALUES (
				$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
				$7::uuid, $8, $9, $10, $11
			)`, id, in.EmployeeID, in.TaskID, in.ExecutionID, kind, position,
			nodeID, nullText(ref.StorageRef), ref.ResourceID, ref.AccessStatus, nullText(ref.Note)); err != nil {
			return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
		}
		position++
	}
	return nil
}

func bumpVersion(ctx context.Context, tx pgx.Tx, employeeID, taskID string, version int) error {
	tag, err := tx.Exec(ctx, `
		UPDATE tasks
		SET version = version + 1, updated_at = now()
		WHERE id = $1::uuid AND employee_id = $2::uuid AND version = $3`,
		taskID, employeeID, version)
	if err != nil {
		return fmt.Errorf("保存执行记录失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() != 1 {
		return errors.New("任务版本已变化")
	}
	return nil
}

func normalizeReport(in *ExecutionReport) error {
	var err error
	for _, id := range []*string{&in.EmployeeID, &in.NodeID, &in.EventID, &in.TaskID, &in.ExecutionID, &in.SessionID} {
		*id, err = identity.ParseUUID(*id)
		if err != nil {
			return err
		}
	}
	switch in.Kind {
	case task.EventStopReport:
		if !validStopReport(*in) {
			return errors.New("中止事实无效")
		}
		return nil
	case task.EventNeedsVerification:
		if in.Status != task.StatusNeedsVerification {
			return errors.New("报告类型无效")
		}
		message, ok := task.UncertainMessage(in.ErrorCode)
		if !ok {
			return errors.New("报告类型无效")
		}
		in.ErrorMessage = message
		return nil
	case task.EventStarted, task.EventResult:
		if in.InputGeneration < 1 {
			return errors.New("代次无效")
		}
		return nil
	default:
		return errors.New("报告类型无效")
	}
}

func retainLateUncertain(ctx context.Context, tx pgx.Tx, in ExecutionReport, head executionHead) error {
	if _, ok := task.UncertainMessage(in.ErrorCode); !ok {
		return errors.New("待核实原因无效")
	}
	if err := bumpVersion(ctx, tx, in.EmployeeID, in.TaskID, head.version); err != nil {
		return err
	}
	return insertReportEvent(ctx, tx, in, head, head.version+1, task.EventNeedsVerification, head.status, in.ErrorCode)
}

func nullText(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func (s *Store) attachResults(ctx context.Context, employeeID string, tasks []task.Record) error {
	return attachResults(ctx, s.pool, employeeID, tasks)
}

func attachResults(ctx context.Context, q queryer, employeeID string, tasks []task.Record) error {
	if len(tasks) == 0 {
		return nil
	}
	ids := make([]string, len(tasks))
	index := make(map[string]int, len(tasks))
	for i := range tasks {
		ids[i] = tasks[i].TaskID
		index[tasks[i].TaskID] = i
	}
	rows, err := q.Query(ctx, `
		SELECT task_id::text, kind, node_id::text, storage_ref, resource_id, access_status, note
		FROM task_result_refs
		WHERE employee_id = $1::uuid AND task_id::text = ANY($2::text[])
		ORDER BY kind, position`, employeeID, ids)
	if err != nil {
		return fmt.Errorf("读取任务结果失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	for rows.Next() {
		var taskID, kind, resourceID, access string
		var nodeID, storage, note *string
		if err := rows.Scan(&taskID, &kind, &nodeID, &storage, &resourceID, &access, &note); err != nil {
			return fmt.Errorf("读取任务结果失败: %s", redact.Scrub(err.Error()))
		}
		ref := task.ResultRef{ResourceID: resourceID, AccessStatus: access}
		if nodeID != nil {
			ref.NodeID = *nodeID
		}
		if storage != nil {
			ref.StorageRef = *storage
		}
		if note != nil {
			ref.Note = *note
		}
		pos, ok := index[taskID]
		if !ok {
			continue
		}
		switch kind {
		case "evidence":
			tasks[pos].Evidence = append(tasks[pos].Evidence, ref)
		case "artifact":
			tasks[pos].Artifacts = append(tasks[pos].Artifacts, ref)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("读取任务结果失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}
