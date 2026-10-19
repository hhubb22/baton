package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"

	"baton/internal/identity"
	"baton/internal/task"

	"github.com/jackc/pgx/v5"
)

// ResolveTask 只修改中心结论，不启动、重放或宣称停止节点上的执行。
func (s *Store) ResolveTask(ctx context.Context, employeeID, taskID string, in task.ResolveInput) (task.Record, error) {
	if err := task.ValidateResolve(in); err != nil {
		return task.Record{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return task.Record{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	previous, err := lockManualTask(ctx, tx, employeeID, taskID)
	if err != nil {
		return task.Record{}, err
	}
	if err := checkManualVersion(previous, in.ExpectedVersion); err != nil {
		return task.Record{}, err
	}
	if err := checkManualStatus(previous); err != nil {
		return task.Record{}, err
	}
	var code, message any
	if in.Status == task.StatusFailed {
		code, message = task.CodeExecutionFailed, in.Reason
	}
	_, err = tx.Exec(ctx, `UPDATE tasks SET status = $3, summary = $4, error_code = $5,
	 error_message = $6, evidence_empty_reason = $7, version = version + 1, updated_at = now()
	 WHERE employee_id = $1::uuid AND id = $2::uuid`, employeeID, taskID, in.Status, in.Summary, code, message, nullText(in.EvidenceEmptyReason))
	if err != nil {
		return task.Record{}, err
	}
	var executionID string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM executions WHERE employee_id = $1::uuid AND task_id = $2::uuid`, employeeID, taskID).Scan(&executionID); err != nil {
		return task.Record{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_result_refs WHERE employee_id = $1::uuid AND task_id = $2::uuid AND kind = 'evidence'`, employeeID, taskID); err != nil {
		return task.Record{}, err
	}
	if err := insertRefKind(ctx, tx, ExecutionReport{EmployeeID: employeeID, TaskID: taskID, ExecutionID: executionID}, "evidence", in.Evidence, 0); err != nil {
		return task.Record{}, err
	}
	if err := enqueueTaskTerminal(ctx, tx, employeeID, taskID); err != nil {
		return task.Record{}, err
	}
	audit := task.Resolution{ResolveInput: in, Previous: previous}
	if err := insertManualEvent(ctx, tx, employeeID, previous, task.EventResolved, in.Status, &audit, nil); err != nil {
		return task.Record{}, err
	}
	rec, _, _, err := loadTask(ctx, tx, ` WHERE employee_id = $1::uuid AND id = $2::uuid`, employeeID, taskID)
	if err != nil {
		return task.Record{}, err
	}
	loaded := []task.Record{rec}
	if err := attachResults(ctx, tx, employeeID, loaded); err != nil {
		return task.Record{}, err
	}
	if err := s.runBeforeCommit(ctx); err != nil {
		return task.Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return task.Record{}, err
	}
	return loaded[0], nil
}

// RerunTask 使用新的任务、执行、Session 和投递身份；原任务只追加审计。
func (s *Store) RerunTask(ctx context.Context, employeeID, taskID string, in task.RerunInput) (task.Record, error) {
	if err := task.ValidateRerun(in); err != nil {
		return task.Record{}, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		rec, err := s.rerunOnce(ctx, employeeID, taskID, in)
		if !errors.Is(err, errTaskRequestUnique) {
			return rec, err
		}
	}
	return task.Record{}, errors.New("并发重做请求未能保存")
}

func (s *Store) rerunOnce(ctx context.Context, employeeID, taskID string, in task.RerunInput) (task.Record, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return task.Record{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	previous, err := lockManualTask(ctx, tx, employeeID, taskID)
	if err != nil {
		return task.Record{}, err
	}
	// 摘要只使用显式重做请求，不依赖原任务之后收到的证据或新的默认配置。
	body, err := json.Marshal(struct {
		Action string
		TaskID string
		Input  task.RerunInput
	}{"rerun", previous.TaskID, in})
	if err != nil {
		return task.Record{}, err
	}
	hash := sha256.Sum256(body)
	tombID, tombHash, found, err := loadTombstone(ctx, tx, employeeID, in.RequestID)
	if err != nil {
		return task.Record{}, err
	}
	if found {
		if sameHash(tombHash, hash[:]) {
			rec, _, exists, err := loadTask(ctx, tx, ` WHERE employee_id = $1::uuid AND id = $2::uuid`, employeeID, tombID)
			if err != nil {
				return task.Record{}, err
			}
			if exists {
				return rec, nil
			}
		}
		return task.Record{}, &task.Rejection{Code: task.CodeConflict, TaskID: tombID, Message: "请求标识已使用，不能创建另一次执行"}
	}
	if err := checkManualVersion(previous, in.ExpectedVersion); err != nil {
		return task.Record{}, err
	}
	if err := checkManualStatus(previous); err != nil {
		return task.Record{}, err
	}
	if previous.Status == task.StatusNeedsVerification && !in.ConfirmSideEffects {
		return task.Record{}, &task.Rejection{Code: task.CodeConflict, TaskID: previous.TaskID,
			CurrentVersion: previous.Version, CurrentStatus: previous.Status,
			Message: "原执行的副作用仍未核实，必须明确确认后才能重做", Fields: []string{"confirm_side_effects"}}
	}
	var queueSeconds int
	if err := tx.QueryRow(ctx, `SELECT queue_timeout_seconds FROM tasks WHERE id = $1::uuid`, taskID).Scan(&queueSeconds); err != nil {
		return task.Record{}, err
	}
	input := task.Input{RequestID: in.RequestID, Description: previous.Description,
		RequiredArtifacts: previous.RequiredArtifacts,
		TargetNodeID:      &previous.TargetNodeID, AgentType: &previous.AgentType,
		WorkingDirectory: previous.WorkingDirectory, AuthorizationScope: previous.AuthorizationScope,
		ExpectedOutputs: previous.ExpectedOutputs, QueueTimeoutSeconds: &queueSeconds,
		ExecutionTimeoutSeconds: &previous.ExecutionTimeoutSeconds}
	if previous.DeviceNames != nil {
		input.DeviceNames = &previous.DeviceNames
	}
	if err := task.Validate(input); err != nil {
		return task.Record{}, err
	}
	target, err := resolveTarget(ctx, tx, employeeID, input.TargetNodeID)
	if err != nil {
		return task.Record{}, err
	}
	agent, err := resolveSession(ctx, tx, employeeID, input, target)
	if err != nil {
		return task.Record{}, err
	}
	rec, err := insertAccepted(ctx, tx, employeeID, task.Prepared{Input: input, Hash: hash[:]}, target.id, agent)
	if err != nil {
		return task.Record{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_relations SET rerun_of_task_id = $3::uuid
	 WHERE employee_id = $1::uuid AND task_id = $2::uuid`, employeeID, rec.TaskID, previous.TaskID); err != nil {
		return task.Record{}, err
	}
	if err := bumpVersion(ctx, tx, employeeID, previous.TaskID, previous.Version); err != nil {
		return task.Record{}, err
	}
	audit := task.Rerun{RerunInput: in, TaskID: rec.TaskID, PreviousStatus: previous.Status}
	if err := insertManualEvent(ctx, tx, employeeID, previous, task.EventRerunRequested, previous.Status, nil, &audit); err != nil {
		return task.Record{}, err
	}
	if err := s.runBeforeCommit(ctx); err != nil {
		return task.Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return task.Record{}, err
	}
	rec.RerunOfTaskID = &previous.TaskID
	return rec, nil
}

func lockManualTask(ctx context.Context, tx pgx.Tx, employeeID, taskID string) (task.Record, error) {
	for _, id := range []string{employeeID, taskID} {
		if _, err := identity.ParseUUID(id); err != nil {
			return task.Record{}, ErrNotVisible
		}
	}
	rec, _, found, err := loadTask(ctx, tx, ` WHERE employee_id = $1::uuid AND id = $2::uuid FOR UPDATE`, employeeID, taskID)
	if err != nil {
		return task.Record{}, err
	}
	if !found {
		return task.Record{}, ErrNotVisible
	}
	loaded := []task.Record{rec}
	if err := attachResults(ctx, tx, employeeID, loaded); err != nil {
		return task.Record{}, err
	}
	return loaded[0], nil
}

func checkManualVersion(rec task.Record, expected int) error {
	if rec.Version == expected {
		return nil
	}
	return &task.Rejection{Code: task.CodeConflict, TaskID: rec.TaskID, Message: "任务版本已变化，请先查询最新记录",
		Fields: []string{"expected_version"}, CurrentVersion: rec.Version, CurrentStatus: rec.Status}
}

func checkManualStatus(rec task.Record) error {
	switch rec.Status {
	case task.StatusNeedsVerification, task.StatusCompleted, task.StatusFailed, task.StatusCancelled:
		return nil
	default:
		return &task.Rejection{Code: task.CodeConflict, TaskID: rec.TaskID, Message: "任务仍在排队或执行，请先查询或请求取消",
			CurrentVersion: rec.Version, CurrentStatus: rec.Status}
	}
}

func insertManualEvent(ctx context.Context, tx pgx.Tx, employeeID string, previous task.Record, kind, status string, resolution *task.Resolution, rerun *task.Rerun) error {
	id, err := identity.NewUUID()
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO task_events (id, employee_id, task_id, version, actor_employee_id,
	 kind, status, target_node_id, agent_type, queue_expires_at, execution_timeout_seconds,
	 execution_id, resolution, rerun, created_at)
	 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $2::uuid, $5, $6, $7::uuid, $8, $9, $10,
	 (SELECT id FROM executions WHERE task_id = $3::uuid AND employee_id = $2::uuid), $11, $12, now())`,
		id, employeeID, previous.TaskID, previous.Version+1, kind, status, previous.TargetNodeID, previous.AgentType,
		previous.QueueExpiresAt, previous.ExecutionTimeoutSeconds, resolution, rerun)
	return err
}
