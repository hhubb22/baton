package store

import (
	"context"
	"time"

	"baton/internal/identity"
	"baton/internal/task"

	"github.com/jackc/pgx/v5"
)

// TaskView 分别提供执行事实与交付事实，不从节点在线状态推断任务结果。
type TaskView struct {
	task.Record
	UpdatedAt         time.Time  `json:"updated_at"`
	DeliveryStatus    string     `json:"delivery_status"`
	DeliveryUpdatedAt *time.Time `json:"delivery_updated_at,omitempty"`
}

type TaskFilter struct {
	IncludeShell bool
	RequestID    string
	ParentTaskID string
	Cursor       string
}

type TaskPage struct {
	Tasks      []TaskView `json:"tasks"`
	NextCursor string     `json:"next_cursor,omitempty"`
}

func (s *Store) ListTaskViews(ctx context.Context, employeeID string, filter TaskFilter) (TaskPage, error) {
	if _, err := identity.ParseUUID(employeeID); err != nil {
		return TaskPage{}, ErrNotVisible
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return TaskPage{}, err
	}
	defer tx.Rollback(ctx)
	// 游标与来源任务必须属于当前员工，不能用其他员工的对象探测排序位置。
	for _, id := range []string{filter.ParentTaskID, filter.Cursor} {
		if id == "" {
			continue
		}
		if _, err := identity.ParseUUID(id); err != nil {
			return TaskPage{}, ErrNotVisible
		}
		_, _, found, err := loadTask(ctx, tx, ` WHERE employee_id = $1::uuid AND id = $2::uuid`, employeeID, id)
		if err != nil {
			return TaskPage{}, err
		}
		if !found {
			return TaskPage{}, ErrNotVisible
		}
	}
	rows, err := tx.Query(ctx, taskSelect+`
 WHERE employee_id = $1::uuid
 AND ($2 OR agent_type <> 'shell')
 AND ($3 = '' OR request_id = $3)
 AND ($4 = '' OR parent_task_id = NULLIF($4, '')::uuid)
 AND ($5 = '' OR (created_at, id) < (SELECT created_at, id FROM tasks WHERE employee_id = $1::uuid AND id = NULLIF($5, '')::uuid))
 ORDER BY created_at DESC, id DESC LIMIT $6`, employeeID, filter.IncludeShell || filter.RequestID != "" || filter.ParentTaskID != "", filter.RequestID, filter.ParentTaskID, filter.Cursor, taskListLimit+1)
	if err != nil {
		return TaskPage{}, err
	}
	records := []task.Record{}
	for rows.Next() {
		rec, _, err := scanTask(rows)
		if err != nil {
			rows.Close()
			return TaskPage{}, err
		}
		records = append(records, rec)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return TaskPage{}, err
	}
	page := TaskPage{}
	if len(records) > taskListLimit {
		records = records[:taskListLimit]
		page.NextCursor = records[len(records)-1].TaskID
	}
	page.Tasks, err = taskViews(ctx, tx, employeeID, records)
	if err != nil {
		return TaskPage{}, err
	}
	return page, tx.Commit(ctx)
}

func (s *Store) GetTaskView(ctx context.Context, employeeID, id string) (TaskView, error) {
	for _, value := range []string{employeeID, id} {
		if _, err := identity.ParseUUID(value); err != nil {
			return TaskView{}, ErrNotVisible
		}
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return TaskView{}, err
	}
	defer tx.Rollback(ctx)
	rec, _, found, err := loadTask(ctx, tx, ` WHERE employee_id = $1::uuid AND id = $2::uuid`, employeeID, id)
	if err != nil {
		return TaskView{}, err
	}
	if !found {
		return TaskView{}, ErrNotVisible
	}
	views, err := taskViews(ctx, tx, employeeID, []task.Record{rec})
	if err != nil {
		return TaskView{}, err
	}
	return views[0], tx.Commit(ctx)
}

func taskViews(ctx context.Context, tx pgx.Tx, employeeID string, records []task.Record) ([]TaskView, error) {
	if err := attachResults(ctx, tx, employeeID, records); err != nil {
		return nil, err
	}
	views := make([]TaskView, len(records))
	if len(records) == 0 {
		return views, nil
	}
	ids := make([]string, len(records))
	indices := make(map[string]int, len(records))
	for i, rec := range records {
		views[i].Record = rec
		ids[i] = rec.TaskID
		indices[rec.TaskID] = i
	}
	rows, err := tx.Query(ctx, `SELECT t.id::text, t.updated_at,
 CASE WHEN t.parent_task_id IS NOT NULL AND t.source_session_id IS NOT NULL THEN
   COALESCE(cd.status, CASE WHEN t.summary IS NOT NULL OR t.status IN ('completed','failed','cancelled') THEN 'pending' ELSE 'not_ready' END)
 ELSE CASE WHEN t.summary IS NOT NULL OR t.status IN ('completed','failed','cancelled') THEN 'stored' ELSE 'not_ready' END END,
 cd.updated_at
 FROM tasks t JOIN executions e ON e.task_id = t.id AND e.employee_id = t.employee_id
 LEFT JOIN child_deliveries cd ON cd.child_execution_id = e.id AND cd.employee_id = t.employee_id
 WHERE t.employee_id = $1::uuid AND t.id = ANY($2::uuid[])`, employeeID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, status string
		var updated time.Time
		var deliveryUpdated *time.Time
		if err := rows.Scan(&id, &updated, &status, &deliveryUpdated); err != nil {
			return nil, err
		}
		i := indices[id]
		views[i].UpdatedAt, views[i].DeliveryStatus, views[i].DeliveryUpdatedAt = updated, status, deliveryUpdated
	}
	return views, rows.Err()
}
