package store

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"

	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/redact"
	"baton/internal/task"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const taskListLimit = 100

// ErrNotVisible 表示任务不属于当前员工，或不存在。两种情况使用同一个错误。
var ErrNotVisible = errors.New("task not visible")

var errTaskRequestUnique = errors.New("task request unique")

// SetTaskCommitHook 在新任务的写入完成之后、事务提交之前运行。
// 返回错误会回滚这次接受，调用方不能把它当成已接受。nil 表示直接提交。
// 命中已有请求时不会调用它。
func (s *Store) SetTaskCommitHook(fn func(context.Context) error) {
	s.mu.Lock()
	s.beforeCommit = fn
	s.mu.Unlock()
}

func (s *Store) runBeforeCommit(ctx context.Context) error {
	s.mu.Lock()
	fn := s.beforeCommit
	s.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx)
}

// SetStartCommitHook 在启动许可写入完成之后、事务提交之前运行。
// 返回错误会回滚，调用方不能签发许可。
func (s *Store) SetStartCommitHook(fn func(context.Context) error) {
	s.mu.Lock()
	s.beforeStartCommit = fn
	s.mu.Unlock()
}

// SetCancelCommitHook 在取消写入完成之后、事务提交之前运行。
func (s *Store) SetCancelCommitHook(fn func(context.Context) error) {
	s.mu.Lock()
	s.beforeCancelCommit = fn
	s.mu.Unlock()
}

func (s *Store) runStartHook(ctx context.Context) error {
	s.mu.Lock()
	fn := s.beforeStartCommit
	s.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx)
}

func (s *Store) runCancelHook(ctx context.Context) error {
	s.mu.Lock()
	fn := s.beforeCancelCommit
	s.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx)
}

// AcceptTask 保存一次任务接受。已有的相同请求直接返回原记录，不重新解析默认 PC 或默认 Agent。
// 任务、execution、初始事件、outbox 和去重墓碑在同一个事务里提交；提交失败时调用方得不到接受记录。
func (s *Store) AcceptTask(ctx context.Context, employeeID string, in task.Input) (task.Record, error) {
	var err error
	employeeID, err = identity.ParseUUID(employeeID)
	if err != nil {
		return task.Record{}, errors.New("员工标识不正确")
	}
	if err := task.ValidateRequestID(in.RequestID); err != nil {
		return task.Record{}, err
	}
	prepared, err := task.Prepare(in)
	if err != nil {
		return task.Record{}, fmt.Errorf("计算请求摘要失败: %s", redact.Scrub(err.Error()))
	}
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		rec, retry, err := s.acceptOnce(ctx, employeeID, prepared)
		if !retry {
			return rec, err
		}
		last = err
	}
	if last == nil {
		last = errors.New("并发提交没有得到结果")
	}
	return task.Record{}, fmt.Errorf("保存任务失败: %s", redact.Scrub(last.Error()))
}

func (s *Store) acceptOnce(ctx context.Context, employeeID string, prepared task.Prepared) (task.Record, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return task.Record{}, false, fmt.Errorf("开始事务失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rec, hash, found, err := loadTask(ctx, tx, ` WHERE employee_id = $1::uuid AND request_id = $2 FOR UPDATE`, employeeID, prepared.Input.RequestID)
	if err != nil {
		return task.Record{}, false, err
	}
	if found {
		if sameHash(hash, prepared.Hash) {
			return rec, false, nil
		}
		return task.Record{}, false, &task.Rejection{
			Code:    task.CodeConflict,
			Message: "相同请求标识的内容不一致",
			TaskID:  rec.TaskID,
		}
	}
	tombID, tombHash, tombFound, err := loadTombstone(ctx, tx, employeeID, prepared.Input.RequestID)
	if err != nil {
		return task.Record{}, false, err
	}
	if tombFound {
		// READ COMMITTED 下，上一条查询可能还没看见刚刚提交的任务。墓碑和任务在同一事务写入，再读一次。
		rec, hash, found, err = loadTask(ctx, tx, ` WHERE employee_id = $1::uuid AND request_id = $2 FOR UPDATE`, employeeID, prepared.Input.RequestID)
		if err != nil {
			return task.Record{}, false, err
		}
		if found {
			if sameHash(hash, prepared.Hash) {
				return rec, false, nil
			}
			return task.Record{}, false, &task.Rejection{
				Code:    task.CodeConflict,
				Message: "相同请求标识的内容不一致",
				TaskID:  rec.TaskID,
			}
		}
		message := "相同请求标识的内容不一致"
		if sameHash(tombHash, prepared.Hash) {
			message = "该请求已经接受过，不能再次创建任务"
		}
		return task.Record{}, false, &task.Rejection{
			Code:    task.CodeConflict,
			Message: message,
			TaskID:  tombID,
		}
	}
	if err := task.Validate(prepared.Input); err != nil {
		return task.Record{}, false, err
	}
	// 旧请求已经在上面返回。这里才解析默认值，并按员工核对 Session 归属。
	if err := checkParent(ctx, tx, employeeID, prepared.Input.ParentTaskID); err != nil {
		return task.Record{}, false, err
	}
	target, err := resolveTarget(ctx, tx, employeeID, prepared.Input.TargetNodeID)
	if err != nil {
		return task.Record{}, false, err
	}
	agent, err := resolveSession(ctx, tx, employeeID, prepared.Input, target)
	if err != nil {
		return task.Record{}, false, err
	}
	rec, err = insertAccepted(ctx, tx, employeeID, prepared, target.id, agent)
	if errors.Is(err, errTaskRequestUnique) {
		return task.Record{}, true, err
	}
	if err != nil {
		return task.Record{}, false, err
	}
	if err := s.runBeforeCommit(ctx); err != nil {
		return task.Record{}, false, fmt.Errorf("提交任务失败: %s", redact.Scrub(err.Error()))
	}
	if err := tx.Commit(ctx); err != nil {
		return task.Record{}, false, fmt.Errorf("提交任务失败: %s", redact.Scrub(err.Error()))
	}
	return rec, false, nil
}

// ListTasks 返回该员工自己的任务，最近的在前，最多 100 条。
func (s *Store) ListTasks(ctx context.Context, employeeID string) ([]task.Record, error) {
	employeeID, err := identity.ParseUUID(employeeID)
	if err != nil {
		return nil, ErrNotVisible
	}
	rows, err := s.pool.Query(ctx, taskSelect+`
		WHERE employee_id = $1::uuid
		ORDER BY created_at DESC, id DESC
		LIMIT $2`, employeeID, taskListLimit)
	if err != nil {
		return nil, fmt.Errorf("读取任务失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	var out []task.Record
	for rows.Next() {
		rec, _, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("读取任务失败: %s", redact.Scrub(err.Error()))
	}
	if out == nil {
		out = []task.Record{}
	}
	return out, nil
}

// GetTask 返回本人的一条任务。其他员工的任务与不存在的任务使用同一个错误。
func (s *Store) GetTask(ctx context.Context, employeeID, taskID string) (task.Record, error) {
	var err error
	employeeID, err = identity.ParseUUID(employeeID)
	if err != nil {
		return task.Record{}, ErrNotVisible
	}
	taskID, err = identity.ParseUUID(taskID)
	if err != nil {
		return task.Record{}, ErrNotVisible
	}
	rec, _, found, err := loadTask(ctx, s.pool, ` WHERE employee_id = $1::uuid AND id = $2::uuid`, employeeID, taskID)
	if err != nil {
		return task.Record{}, err
	}
	if !found {
		return task.Record{}, ErrNotVisible
	}
	return rec, nil
}

// ListTaskEvents 返回本人任务的变更。任务不可见时不返回任何事件。
func (s *Store) ListTaskEvents(ctx context.Context, employeeID, taskID string) ([]task.Event, error) {
	if _, err := s.GetTask(ctx, employeeID, taskID); err != nil {
		return nil, err
	}
	employeeID, err := identity.ParseUUID(employeeID)
	if err != nil {
		return nil, ErrNotVisible
	}
	taskID, err = identity.ParseUUID(taskID)
	if err != nil {
		return nil, ErrNotVisible
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, task_id::text, version, kind, actor_employee_id::text,
		       status, target_node_id::text, agent_type, queue_expires_at,
		       execution_timeout_seconds, reason_code, created_at
		FROM task_events
		WHERE employee_id = $1::uuid AND task_id = $2::uuid
		ORDER BY version ASC`, employeeID, taskID)
	if err != nil {
		return nil, fmt.Errorf("读取任务事件失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	var out []task.Event
	for rows.Next() {
		var ev task.Event
		if err := rows.Scan(
			&ev.EventID, &ev.TaskID, &ev.Version, &ev.Kind, &ev.ActorEmployeeID,
			&ev.Status, &ev.TargetNodeID, &ev.AgentType, &ev.QueueExpiresAt,
			&ev.ExecutionTimeoutSeconds, &ev.ReasonCode, &ev.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("读取任务事件失败: %s", redact.Scrub(err.Error()))
		}
		ev.QueueExpiresAt = ev.QueueExpiresAt.UTC()
		ev.CreatedAt = ev.CreatedAt.UTC()
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("读取任务事件失败: %s", redact.Scrub(err.Error()))
	}
	if out == nil {
		out = []task.Event{}
	}
	return out, nil
}

type ownedNode struct {
	id           string
	revoked      bool
	role         string
	caps         []string
	defaultAgent *string
}

func resolveTarget(ctx context.Context, tx pgx.Tx, employeeID string, explicit *string) (ownedNode, error) {
	if explicit == nil {
		return resolveDefaultPC(ctx, tx, employeeID)
	}
	target, err := loadOwnedNode(ctx, tx, employeeID, *explicit)
	if err != nil {
		return ownedNode{}, err
	}
	if target.revoked {
		return ownedNode{}, &task.Rejection{
			Code:    task.CodeInvalidTarget,
			Message: "目标节点已失效",
			Fields:  []string{"target_node_id"},
		}
	}
	return target, nil
}

func resolveDefaultPC(ctx context.Context, tx pgx.Tx, employeeID string) (ownedNode, error) {
	if _, err := tx.Exec(ctx, `
		INSERT INTO employee_settings (employee_id, default_pc_node_id, updated_at)
		VALUES ($1::uuid, NULL, now())
		ON CONFLICT (employee_id) DO NOTHING`, employeeID); err != nil {
		return ownedNode{}, fmt.Errorf("读取默认 PC 失败: %s", redact.Scrub(err.Error()))
	}
	var nodeID string
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(default_pc_node_id::text, '')
		FROM employee_settings
		WHERE employee_id = $1::uuid
		FOR UPDATE`, employeeID).Scan(&nodeID); err != nil {
		return ownedNode{}, fmt.Errorf("读取默认 PC 失败: %s", redact.Scrub(err.Error()))
	}
	if nodeID == "" {
		return ownedNode{}, &task.Rejection{
			Code:    task.CodeInvalidTarget,
			Message: "请先选择目标节点",
			Fields:  []string{"target_node_id"},
		}
	}
	target, err := loadOwnedNode(ctx, tx, employeeID, nodeID)
	if err != nil {
		return ownedNode{}, err
	}
	if target.revoked || target.role != node.RolePC {
		return ownedNode{}, &task.Rejection{
			Code:    task.CodeInvalidTarget,
			Message: "默认 PC 已失效，请先重新选择目标节点",
			Fields:  []string{"target_node_id"},
		}
	}
	return target, nil
}

func loadOwnedNode(ctx context.Context, tx pgx.Tx, employeeID, nodeID string) (ownedNode, error) {
	var target ownedNode
	target.id = nodeID
	err := tx.QueryRow(ctx, `
		SELECT revoked_at IS NOT NULL, role, capabilities, default_agent_type
		FROM nodes
		WHERE id = $1::uuid AND employee_id = $2::uuid
		FOR UPDATE`, nodeID, employeeID).Scan(&target.revoked, &target.role, &target.caps, &target.defaultAgent)
	if errors.Is(err, pgx.ErrNoRows) {
		var other bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM nodes WHERE id = $1::uuid AND employee_id <> $2::uuid
			)`, nodeID, employeeID).Scan(&other); err != nil {
			return ownedNode{}, fmt.Errorf("读取节点失败: %s", redact.Scrub(err.Error()))
		}
		if other {
			return ownedNode{}, &task.Rejection{
				Code:    task.CodeForbidden,
				Message: "不能引用其他员工的对象",
				Fields:  []string{"target_node_id"},
			}
		}
		return ownedNode{}, &task.Rejection{
			Code:    task.CodeInvalidTarget,
			Message: "找不到目标节点",
			Fields:  []string{"target_node_id"},
		}
	}
	if err != nil {
		return ownedNode{}, fmt.Errorf("读取节点失败: %s", redact.Scrub(err.Error()))
	}
	if target.caps == nil {
		target.caps = []string{}
	}
	return target, nil
}

func chooseAgent(explicit, fallback *string, caps []string) (string, error) {
	chosen := ""
	if explicit != nil {
		chosen = *explicit
	} else if fallback != nil {
		chosen = *fallback
	}
	if chosen == "" {
		return "", &task.Rejection{
			Code:    task.CodeInvalidRequest,
			Message: "未指定 Agent 类型，目标节点也没有默认 Agent",
			Fields:  []string{"agent_type"},
		}
	}
	for _, cap := range caps {
		if cap == chosen {
			return chosen, nil
		}
	}
	return "", &task.Rejection{
		Code:    task.CodeUnsupported,
		Message: "目标节点不支持该 Agent",
		Fields:  []string{"agent_type"},
	}
}

func checkParent(ctx context.Context, tx pgx.Tx, employeeID string, parent *string) error {
	if parent == nil {
		return nil
	}
	var own, other bool
	if err := tx.QueryRow(ctx, `
		SELECT
			EXISTS (SELECT 1 FROM tasks WHERE id = $1::uuid AND employee_id = $2::uuid),
			EXISTS (SELECT 1 FROM tasks WHERE id = $1::uuid AND employee_id <> $2::uuid)`,
		*parent, employeeID).Scan(&own, &other); err != nil {
		return fmt.Errorf("读取来源任务失败: %s", redact.Scrub(err.Error()))
	}
	if own {
		return nil
	}
	if other {
		return &task.Rejection{
			Code:    task.CodeForbidden,
			Message: "不能引用其他员工的对象",
			Fields:  []string{"parent_task_id"},
		}
	}
	return &task.Rejection{
		Code:    task.CodeInvalidTarget,
		Message: "找不到来源任务",
		Fields:  []string{"parent_task_id"},
	}
}

func insertAccepted(ctx context.Context, tx pgx.Tx, employeeID string, prepared task.Prepared, targetID, agent string) (task.Record, error) {
	in := prepared.Input
	taskID, err := identity.NewUUID()
	if err != nil {
		return task.Record{}, err
	}
	executionID, err := identity.NewUUID()
	if err != nil {
		return task.Record{}, err
	}
	eventID, err := identity.NewUUID()
	if err != nil {
		return task.Record{}, err
	}
	messageID, err := identity.NewUUID()
	if err != nil {
		return task.Record{}, err
	}
	queueSeconds := task.DefaultQueueTimeoutSeconds
	if in.QueueTimeoutSeconds != nil {
		queueSeconds = *in.QueueTimeoutSeconds
	}
	execSeconds := task.DefaultExecutionTimeoutSeconds
	if in.ExecutionTimeoutSeconds != nil {
		execSeconds = *in.ExecutionTimeoutSeconds
	}
	rec := task.Record{
		TaskID:                  taskID,
		RequestID:               in.RequestID,
		Description:             in.Description,
		SourceSessionID:         in.SourceSessionID,
		ParentTaskID:            in.ParentTaskID,
		TargetSessionID:         in.TargetSessionID,
		WorkingDirectory:        in.WorkingDirectory,
		AuthorizationScope:      in.AuthorizationScope,
		ExpectedOutputs:         in.ExpectedOutputs,
		TargetNodeID:            targetID,
		AgentType:               agent,
		Status:                  task.StatusQueued,
		ExecutionTimeoutSeconds: execSeconds,
		Version:                 1,
	}
	if in.DeviceNames != nil {
		rec.DeviceNames = append([]string(nil), (*in.DeviceNames)...)
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO tasks (
			id, employee_id, request_id, request_hash, description,
			source_session_id, parent_task_id, target_session_id,
			working_directory, device_names, authorization_scope, expected_outputs,
			requested_target_node_id, requested_agent_type,
			requested_queue_timeout_seconds, requested_execution_timeout_seconds,
			target_node_id, agent_type,
			queue_timeout_seconds, execution_timeout_seconds,
			queue_expires_at, status, version, created_at, updated_at
		) VALUES (
			$1::uuid, $2::uuid, $3, $4, $5,
			$6::uuid, $7::uuid, $8::uuid,
			$9, $10, $11, $12,
			$13::uuid, $14,
			$15, $16,
			$17::uuid, $18,
			$19, $20,
			now() + ($19::int * interval '1 second'), 'queued', 1, now(), now()
		)
		RETURNING created_at, queue_expires_at`,
		taskID, employeeID, in.RequestID, prepared.Hash, in.Description,
		nullString(in.SourceSessionID), nullString(in.ParentTaskID), nullString(in.TargetSessionID),
		nullString(in.WorkingDirectory), nullDevices(in.DeviceNames), nullString(in.AuthorizationScope), nullString(in.ExpectedOutputs),
		nullString(in.TargetNodeID), nullString(in.AgentType),
		nullInt(in.QueueTimeoutSeconds), nullInt(in.ExecutionTimeoutSeconds),
		targetID, agent, queueSeconds, execSeconds,
	).Scan(&rec.AcceptedAt, &rec.QueueExpiresAt)
	if err != nil {
		if uniqueRequest(err) {
			return task.Record{}, errTaskRequestUnique
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" && pgErr.ConstraintName == "tasks_parent_fk" {
			return task.Record{}, &task.Rejection{
				Code:    task.CodeInvalidTarget,
				Message: "找不到来源任务",
				Fields:  []string{"parent_task_id"},
			}
		}
		return task.Record{}, fmt.Errorf("保存任务失败: %s", redact.Scrub(err.Error()))
	}
	rec.AcceptedAt = rec.AcceptedAt.UTC()
	rec.QueueExpiresAt = rec.QueueExpiresAt.UTC()

	if _, err := tx.Exec(ctx, `
		INSERT INTO executions (
			id, task_id, employee_id, target_node_id,
			storage_generation, prepared_at, start_authorized_at, created_at
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4::uuid,
			NULL, NULL, NULL, $5
		)`, executionID, taskID, employeeID, targetID, rec.AcceptedAt); err != nil {
		return task.Record{}, fmt.Errorf("保存执行身份失败: %s", redact.Scrub(err.Error()))
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_events (
			id, task_id, employee_id, version, actor_employee_id, kind,
			status, target_node_id, agent_type, queue_expires_at,
			execution_timeout_seconds, created_at
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, 1, $3::uuid, 'accepted',
			'queued', $4::uuid, $5, $6, $7, $8
		)`, eventID, taskID, employeeID, targetID, agent, rec.QueueExpiresAt, execSeconds, rec.AcceptedAt); err != nil {
		return task.Record{}, fmt.Errorf("保存任务事件失败: %s", redact.Scrub(err.Error()))
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO dispatch_outbox (
			id, employee_id, task_id, execution_id, target_node_id,
			action, send_deadline, lease_until, created_at
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
			'prepare', $6, NULL, $7
		)`, messageID, employeeID, taskID, executionID, targetID, rec.QueueExpiresAt, rec.AcceptedAt); err != nil {
		return task.Record{}, fmt.Errorf("保存投递意图失败: %s", redact.Scrub(err.Error()))
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO request_tombstones (
			employee_id, request_id, request_hash, task_id, created_at
		) VALUES (
			$1::uuid, $2, $3, $4::uuid, $5
		)`, employeeID, in.RequestID, prepared.Hash, taskID, rec.AcceptedAt); err != nil {
		return task.Record{}, fmt.Errorf("保存去重记录失败: %s", redact.Scrub(err.Error()))
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_relations (
			employee_id, task_id, source_task_id, source_session_id, target_session_id,
			created_at, updated_at
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $6
		)`, employeeID, taskID, nullString(in.ParentTaskID), nullString(in.SourceSessionID), nullString(in.TargetSessionID), rec.AcceptedAt); err != nil {
		return task.Record{}, fmt.Errorf("保存任务关系失败: %s", redact.Scrub(err.Error()))
	}
	if in.TargetSessionID != nil {
		tag, err := tx.Exec(ctx, `
			UPDATE sessions
			SET bound_execution_id = $1::uuid, updated_at = $2
			WHERE employee_id = $3::uuid AND id = $4::uuid AND bound_execution_id IS NULL`,
			executionID, rec.AcceptedAt, employeeID, *in.TargetSessionID)
		if err != nil {
			return task.Record{}, fmt.Errorf("占用 Session 失败: %s", redact.Scrub(err.Error()))
		}
		if tag.RowsAffected() != 1 {
			return task.Record{}, &task.Rejection{
				Code:    task.CodeSessionBusy,
				Message: "Session 正在执行其他任务",
				Fields:  []string{"target_session_id"},
			}
		}
	}
	return rec, nil
}

const taskSelect = `
	SELECT id::text, request_hash, request_id, description,
	       source_session_id::text, parent_task_id::text, target_session_id::text,
	       working_directory, device_names, authorization_scope, expected_outputs,
	       target_node_id::text, agent_type, execution_timeout_seconds,
	       queue_expires_at, status, version, created_at, error_code, error_message
	FROM tasks`

type queryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func loadTask(ctx context.Context, q queryer, where string, args ...any) (task.Record, []byte, bool, error) {
	rows, err := q.Query(ctx, taskSelect+where, args...)
	if err != nil {
		return task.Record{}, nil, false, fmt.Errorf("读取任务失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return task.Record{}, nil, false, fmt.Errorf("读取任务失败: %s", redact.Scrub(err.Error()))
		}
		return task.Record{}, nil, false, nil
	}
	rec, hash, err := scanTask(rows)
	if err != nil {
		return task.Record{}, nil, false, err
	}
	return rec, hash, true, nil
}

func scanTask(row pgx.Row) (task.Record, []byte, error) {
	var rec task.Record
	var hash []byte
	var devices []string
	if err := row.Scan(
		&rec.TaskID, &hash, &rec.RequestID, &rec.Description,
		&rec.SourceSessionID, &rec.ParentTaskID, &rec.TargetSessionID,
		&rec.WorkingDirectory, &devices, &rec.AuthorizationScope, &rec.ExpectedOutputs,
		&rec.TargetNodeID, &rec.AgentType, &rec.ExecutionTimeoutSeconds,
		&rec.QueueExpiresAt, &rec.Status, &rec.Version, &rec.AcceptedAt,
		&rec.ErrorCode, &rec.ErrorMessage,
	); err != nil {
		return task.Record{}, nil, fmt.Errorf("读取任务失败: %s", redact.Scrub(err.Error()))
	}
	rec.DeviceNames = devices
	rec.QueueExpiresAt = rec.QueueExpiresAt.UTC()
	rec.AcceptedAt = rec.AcceptedAt.UTC()
	return rec, hash, nil
}

func loadTombstone(ctx context.Context, tx pgx.Tx, employeeID, requestID string) (string, []byte, bool, error) {
	var taskID string
	var hash []byte
	err := tx.QueryRow(ctx, `
		SELECT task_id::text, request_hash
		FROM request_tombstones
		WHERE employee_id = $1::uuid AND request_id = $2`, employeeID, requestID).Scan(&taskID, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, false, nil
	}
	if err != nil {
		return "", nil, false, fmt.Errorf("读取去重记录失败: %s", redact.Scrub(err.Error()))
	}
	return taskID, hash, true, nil
}

func sameHash(a, b []byte) bool {
	if len(a) == 0 || len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

func uniqueRequest(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "tasks_employee_request_unique"
}

func nullString(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullInt(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullDevices(p *[]string) any {
	if p == nil {
		return nil
	}
	return *p
}
