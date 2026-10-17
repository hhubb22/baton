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

// WorkSession 是中心保存的执行 Session 元数据，以及它和任务的关系。不含会话原文。
type WorkSession struct {
	SessionID         string    `json:"session_id"`
	NodeID            string    `json:"node_id"`
	AgentType         string    `json:"agent_type"`
	Status            string    `json:"status"`
	Busy              bool      `json:"busy"`
	ParentSessionID   *string   `json:"parent_session_id,omitempty"`
	NativeSessionID   *string   `json:"native_session_id,omitempty"`
	BoundExecutionID  *string   `json:"bound_execution_id,omitempty"`
	StorageGeneration *string   `json:"storage_generation,omitempty"`
	TaskIDs           []string  `json:"task_ids"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type ownedSession struct {
	id        string
	nodeID    string
	agentType string
	status    string
	bound     *string
}

func resolveSession(ctx context.Context, tx pgx.Tx, employeeID string, in task.Input, target ownedNode) (string, error) {
	if in.SourceSessionID != nil {
		if _, err := loadOwnedSession(ctx, tx, employeeID, *in.SourceSessionID, "source_session_id"); err != nil {
			return "", err
		}
	}
	if in.TargetSessionID == nil {
		return chooseAgent(in.AgentType, target.defaultAgent, target.caps)
	}
	sess, err := loadOwnedSession(ctx, tx, employeeID, *in.TargetSessionID, "target_session_id")
	if err != nil {
		return "", err
	}
	if sess.nodeID != target.id {
		return "", &task.Rejection{
			Code:    task.CodeInvalidTarget,
			Message: "Session 不在目标节点上",
			Fields:  []string{"target_session_id"},
		}
	}
	if err := sessionReceivable(sess); err != nil {
		return "", err
	}
	if in.AgentType != nil && *in.AgentType != sess.agentType {
		return "", &task.Rejection{
			Code:    task.CodeUnsupported,
			Message: "显式 Agent 类型与 Session 不一致",
			Fields:  []string{"agent_type", "target_session_id"},
		}
	}
	return chooseAgent(&sess.agentType, nil, target.caps)
}

func sessionReceivable(sess ownedSession) error {
	switch sess.status {
	case "stopped":
		return &task.Rejection{
			Code:    task.CodeInvalidTarget,
			Message: "Session 已停止，不能接收任务",
			Fields:  []string{"target_session_id"},
		}
	case "unknown":
		return &task.Rejection{
			Code:    task.CodeInvalidTarget,
			Message: "Session 状态未知，不能接收任务",
			Fields:  []string{"target_session_id"},
		}
	case "running", "waiting_input":
		return &task.Rejection{
			Code:    task.CodeSessionBusy,
			Message: "Session 正在执行其他任务",
			Fields:  []string{"target_session_id"},
		}
	case "idle":
		if sess.bound != nil {
			return &task.Rejection{
				Code:    task.CodeSessionBusy,
				Message: "Session 正在执行其他任务",
				Fields:  []string{"target_session_id"},
			}
		}
		return nil
	default:
		return &task.Rejection{
			Code:    task.CodeInvalidTarget,
			Message: "Session 状态无法确认",
			Fields:  []string{"target_session_id"},
		}
	}
}

func loadOwnedSession(ctx context.Context, tx pgx.Tx, employeeID, sessionID, field string) (ownedSession, error) {
	var sess ownedSession
	sess.id = sessionID
	err := tx.QueryRow(ctx, `
		SELECT node_id::text, agent_type, status, bound_execution_id::text
		FROM sessions
		WHERE id = $1::uuid AND employee_id = $2::uuid
		FOR UPDATE`, sessionID, employeeID).Scan(&sess.nodeID, &sess.agentType, &sess.status, &sess.bound)
	if err == nil {
		return sess, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return ownedSession{}, fmt.Errorf("读取 Session 失败: %s", redact.Scrub(err.Error()))
	}
	var other bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM sessions WHERE id = $1::uuid AND employee_id <> $2::uuid
		)`, sessionID, employeeID).Scan(&other); err != nil {
		return ownedSession{}, fmt.Errorf("读取 Session 失败: %s", redact.Scrub(err.Error()))
	}
	if other {
		return ownedSession{}, &task.Rejection{
			Code:    task.CodeForbidden,
			Message: "不能引用其他员工的对象",
			Fields:  []string{field},
		}
	}
	return ownedSession{}, &task.Rejection{
		Code:    task.CodeInvalidTarget,
		Message: "找不到可确认归属的 Session",
		Fields:  []string{field},
	}
}

// ListSessions 返回该员工的 Session 元数据和关联任务。
func (s *Store) ListSessions(ctx context.Context, employeeID string) ([]WorkSession, error) {
	employeeID, err := identity.ParseUUID(employeeID)
	if err != nil {
		return nil, ErrNotVisible
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text
		FROM sessions
		WHERE employee_id = $1::uuid
		ORDER BY updated_at DESC, id DESC
		LIMIT 100`, employeeID)
	if err != nil {
		return nil, fmt.Errorf("读取 Session 失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("读取 Session 失败: %s", redact.Scrub(err.Error()))
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("读取 Session 失败: %s", redact.Scrub(err.Error()))
	}
	out := make([]WorkSession, 0, len(ids))
	for _, id := range ids {
		item, err := s.GetSession(ctx, employeeID, id)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

// GetSession 返回本人的一条 Session。其他员工的 Session 与不存在的 Session 使用同一个错误。
func (s *Store) GetSession(ctx context.Context, employeeID, sessionID string) (WorkSession, error) {
	var err error
	employeeID, err = identity.ParseUUID(employeeID)
	if err != nil {
		return WorkSession{}, ErrNotVisible
	}
	sessionID, err = identity.ParseUUID(sessionID)
	if err != nil {
		return WorkSession{}, ErrNotVisible
	}
	var item WorkSession
	err = s.pool.QueryRow(ctx, `
		SELECT id::text, node_id::text, agent_type, status,
		       parent_session_id::text, native_session_id, bound_execution_id::text,
		       storage_generation, updated_at
		FROM sessions
		WHERE employee_id = $1::uuid AND id = $2::uuid`, employeeID, sessionID).Scan(
		&item.SessionID, &item.NodeID, &item.AgentType, &item.Status,
		&item.ParentSessionID, &item.NativeSessionID, &item.BoundExecutionID,
		&item.StorageGeneration, &item.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return WorkSession{}, ErrNotVisible
	}
	if err != nil {
		return WorkSession{}, fmt.Errorf("读取 Session 失败: %s", redact.Scrub(err.Error()))
	}
	item.UpdatedAt = item.UpdatedAt.UTC()
	item.Busy = item.BoundExecutionID != nil || item.Status == "running" || item.Status == "waiting_input"
	rows, err := s.pool.Query(ctx, `
		SELECT id::text
		FROM tasks
		WHERE employee_id = $1::uuid
		  AND (source_session_id = $2::uuid OR target_session_id = $2::uuid)
		ORDER BY created_at, id`, employeeID, sessionID)
	if err != nil {
		return WorkSession{}, fmt.Errorf("读取 Session 关系失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	item.TaskIDs = []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return WorkSession{}, fmt.Errorf("读取 Session 关系失败: %s", redact.Scrub(err.Error()))
		}
		item.TaskIDs = append(item.TaskIDs, id)
	}
	if err := rows.Err(); err != nil {
		return WorkSession{}, fmt.Errorf("读取 Session 关系失败: %s", redact.Scrub(err.Error()))
	}
	return item, nil
}
