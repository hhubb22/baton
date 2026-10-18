package store

import (
	"context"
	"errors"

	"baton/internal/identity"
	"baton/internal/task"

	"github.com/jackc/pgx/v5"
)

// AgentSource 的员工、节点来自 Relay，任务三元组来自 batond 的持久化凭据绑定。
type AgentSource struct {
	EmployeeID, NodeID, TaskID, SessionID, ExecutionID string
}

func agentDenied() error {
	return &task.Rejection{Code: task.CodeForbidden, Message: "来源上下文或任务权限不匹配"}
}

func validateAgentSource(ctx context.Context, tx pgx.Tx, source AgentSource) (bool, error) {
	for _, id := range []string{source.EmployeeID, source.NodeID, source.TaskID, source.SessionID, source.ExecutionID} {
		if _, err := identity.ParseUUID(id); err != nil {
			return false, agentDenied()
		}
	}
	var active bool
	err := tx.QueryRow(ctx, `
	 SELECT COALESCE(t.status = 'running' AND t.cancel_requested_at IS NULL
	   AND t.execution_expires_at > now() AND e.start_authorized_at IS NOT NULL
	   AND e.start_refused_at IS NULL AND s.bound_execution_id = e.id, false)
	 FROM tasks t JOIN executions e ON e.task_id = t.id AND e.employee_id = t.employee_id
	 JOIN sessions s ON s.id = t.target_session_id AND s.employee_id = t.employee_id
	 JOIN nodes n ON n.id = t.target_node_id AND n.employee_id = t.employee_id
	 WHERE t.employee_id = $1::uuid AND t.id = $2::uuid AND e.id = $3::uuid
	   AND t.target_node_id = $4::uuid AND t.target_session_id = $5::uuid AND n.revoked_at IS NULL
	 FOR UPDATE OF t`, source.EmployeeID, source.TaskID, source.ExecutionID, source.NodeID, source.SessionID).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, agentDenied()
	}
	return active, err
}

// AcceptDelegation 只继承完全相同的授权文本，不尝试猜测自由文本权限的包含关系。
func (s *Store) AcceptDelegation(ctx context.Context, source AgentSource, in task.Input) (task.Record, error) {
	if (in.SourceSessionID != nil && *in.SourceSessionID != source.SessionID) ||
		(in.ParentTaskID != nil && *in.ParentTaskID != source.TaskID) {
		return task.Record{}, agentDenied()
	}
	parent, err := s.AgentTask(ctx, source, source.TaskID)
	if err != nil {
		return task.Record{}, err
	}
	if in.AuthorizationScope != nil && (parent.AuthorizationScope == nil || *in.AuthorizationScope != *parent.AuthorizationScope) {
		return task.Record{}, agentDenied()
	}
	in.SourceSessionID, in.ParentTaskID = &source.SessionID, &source.TaskID
	in.AuthorizationScope = parent.AuthorizationScope
	return s.acceptTask(ctx, source.EmployeeID, in, &source)
}

// AgentTask 限定当前来源任务及其直接委托；不能按员工权限扫描无关任务。
func (s *Store) AgentTask(ctx context.Context, source AgentSource, taskID string) (task.Record, error) {
	if _, err := identity.ParseUUID(taskID); err != nil {
		return task.Record{}, agentDenied()
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return task.Record{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := validateAgentSource(ctx, tx, source); err != nil {
		return task.Record{}, err
	}
	if taskID != source.TaskID {
		var visible bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM task_relations
		 WHERE employee_id = $1::uuid AND task_id = $2::uuid
		 AND source_task_id = $3::uuid AND source_session_id = $4::uuid)`,
			source.EmployeeID, taskID, source.TaskID, source.SessionID).Scan(&visible); err != nil {
			return task.Record{}, err
		}
		if !visible {
			return task.Record{}, agentDenied()
		}
	}
	rec, _, found, err := loadTask(ctx, tx, ` WHERE employee_id = $1::uuid AND id = $2::uuid FOR SHARE`, source.EmployeeID, taskID)
	if err != nil {
		return task.Record{}, err
	}
	if !found {
		return task.Record{}, agentDenied()
	}
	loaded := []task.Record{rec}
	if err := attachResults(ctx, tx, source.EmployeeID, loaded); err != nil {
		return task.Record{}, err
	}
	return loaded[0], nil
}

type AgentTaskView struct {
	task.Record
	ExecutionID    string `json:"execution_id"`
	DeliveryStatus string `json:"delivery_status"`
}

type AgentResultView struct {
	TaskID               string            `json:"task_id"`
	TargetNodeID         string            `json:"target_node_id"`
	SessionID            *string           `json:"session_id"`
	ExecutionID          string            `json:"execution_id"`
	Status               string            `json:"status"`
	Ready                bool              `json:"ready"`
	Summary              *string           `json:"summary"`
	Evidence             []task.ResultRef  `json:"evidence"`
	Artifacts            []task.ResultRef  `json:"artifacts"`
	EvidenceEmptyReason  *string           `json:"evidence_empty_reason,omitempty"`
	ArtifactsEmptyReason *string           `json:"artifacts_empty_reason,omitempty"`
	Error                *AgentResultError `json:"error"`
}

type AgentResultError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (s *Store) AgentResult(ctx context.Context, source AgentSource, id string) (AgentResultView, error) {
	view, err := s.AgentTaskView(ctx, source, id)
	if err != nil {
		return AgentResultView{}, err
	}
	out := AgentResultView{TaskID: id, TargetNodeID: view.TargetNodeID, SessionID: view.TargetSessionID,
		ExecutionID: view.ExecutionID, Status: view.Status, Ready: view.Summary != nil,
		Summary: view.Summary, Evidence: view.Evidence, Artifacts: view.Artifacts,
		EvidenceEmptyReason: view.EvidenceEmptyReason, ArtifactsEmptyReason: view.ArtifactsEmptyReason}
	if out.Evidence == nil {
		out.Evidence = []task.ResultRef{}
	}
	if out.Artifacts == nil {
		out.Artifacts = []task.ResultRef{}
	}
	if view.ErrorCode != nil {
		out.Error = &AgentResultError{Code: *view.ErrorCode}
		if view.ErrorMessage != nil {
			out.Error.Message = *view.ErrorMessage
		}
	}
	return out, nil
}

type AgentRelation struct {
	TaskID          string  `json:"task_id"`
	SourceTaskID    *string `json:"source_task_id"`
	SourceSessionID *string `json:"source_session_id"`
	TargetNodeID    string  `json:"target_node_id"`
	TargetSessionID *string `json:"target_session_id"`
	ExecutionID     string  `json:"execution_id"`
}

func (s *Store) AgentTaskView(ctx context.Context, source AgentSource, id string) (AgentTaskView, error) {
	rec, err := s.AgentTask(ctx, source, id)
	if err != nil {
		return AgentTaskView{}, err
	}
	out := AgentTaskView{Record: rec}
	err = s.pool.QueryRow(ctx, `SELECT e.id::text,
	 CASE WHEN EXISTS (SELECT 1 FROM delivery_records d WHERE d.execution_id = e.id) THEN 'delivered' ELSE 'not_delivered' END
	 FROM executions e WHERE e.employee_id = $1::uuid AND e.task_id = $2::uuid`, source.EmployeeID, id).Scan(&out.ExecutionID, &out.DeliveryStatus)
	return out, err
}

func (s *Store) AgentRelations(ctx context.Context, source AgentSource, id string) ([]AgentRelation, error) {
	if _, err := s.AgentTask(ctx, source, id); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT t.id::text, r.source_task_id::text, r.source_session_id::text,
	 t.target_node_id::text, r.target_session_id::text, e.id::text
	 FROM tasks t JOIN task_relations r ON r.task_id = t.id AND r.employee_id = t.employee_id
	 JOIN executions e ON e.task_id = t.id AND e.employee_id = t.employee_id
	 WHERE t.employee_id = $1::uuid AND (t.id = $2::uuid OR
	 (r.source_task_id = $2::uuid AND r.source_session_id = $3::uuid))
	 ORDER BY t.created_at, t.id LIMIT 101`, source.EmployeeID, id, source.SessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AgentRelation, 0)
	for rows.Next() {
		var relation AgentRelation
		if err := rows.Scan(&relation.TaskID, &relation.SourceTaskID, &relation.SourceSessionID, &relation.TargetNodeID, &relation.TargetSessionID, &relation.ExecutionID); err != nil {
			return nil, err
		}
		out = append(out, relation)
	}
	if len(out) > 100 {
		return nil, &task.Rejection{Code: task.CodeUnavailable, Message: "关系超过单次查询上限，请按子任务查询"}
	}
	return out, rows.Err()
}
