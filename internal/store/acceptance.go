package store

import (
	"context"

	"baton/internal/identity"
	"baton/internal/task"
)

// AcceptResult 保存员工验收与回写意图，保留任务的执行结论。
func (s *Store) AcceptResult(ctx context.Context, employeeID, taskID string, in task.AcceptanceInput) (task.Acceptance, error) {
	if err := task.ValidateAcceptance(in); err != nil {
		return task.Acceptance{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return task.Acceptance{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rec, err := lockManualTask(ctx, tx, employeeID, taskID)
	if err != nil {
		return task.Acceptance{}, err
	}
	if err := checkManualVersion(rec, in.ExpectedVersion); err != nil {
		return task.Acceptance{}, err
	}
	if rec.Status != task.StatusCompleted && rec.Status != task.StatusFailed && rec.Status != task.StatusCancelled {
		return task.Acceptance{}, &task.Rejection{Code: task.CodeConflict, Message: "执行结论尚未确定，请先核实结果", CurrentVersion: rec.Version, CurrentStatus: rec.Status}
	}
	id, err := identity.NewUUID()
	if err != nil {
		return task.Acceptance{}, err
	}
	if err := bumpVersion(ctx, tx, employeeID, taskID, rec.Version); err != nil {
		return task.Acceptance{}, err
	}
	out := task.Acceptance{ID: id, TaskID: taskID, TaskVersion: rec.Version + 1, EmployeeID: employeeID, Decision: in.Decision, Comment: in.Comment}
	err = tx.QueryRow(ctx, `INSERT INTO task_acceptances(id,employee_id,task_id,task_version,decision,comment)
		VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at`, id, employeeID, taskID, out.TaskVersion, in.Decision, in.Comment).Scan(&out.CreatedAt)
	if err != nil {
		return task.Acceptance{}, err
	}
	if err := s.runBeforeCommit(ctx); err != nil {
		return task.Acceptance{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return task.Acceptance{}, err
	}
	return out, nil
}

func (s *Store) ListAcceptances(ctx context.Context, employeeID, taskID string) ([]task.Acceptance, error) {
	if _, err := s.GetTask(ctx, employeeID, taskID); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id::text,task_version,decision,comment,created_at FROM task_acceptances
		WHERE employee_id=$1 AND task_id=$2 ORDER BY task_version`, employeeID, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []task.Acceptance{}
	for rows.Next() {
		a := task.Acceptance{TaskID: taskID, EmployeeID: employeeID}
		if err := rows.Scan(&a.ID, &a.TaskVersion, &a.Decision, &a.Comment, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
