package store

import (
	"context"
	"encoding/json"
	"errors"

	"baton/internal/inbox"
	"baton/internal/protocol"
	"baton/internal/task"
	"github.com/jackc/pgx/v5"
)

func inboxBinding(b projectRunBinding) inbox.Binding {
	return inbox.Binding{EmployeeID: b.owner, ProjectID: b.projectID, AgentID: b.agentID, ConversationID: b.conversationID}
}
func (s *Store) Inbox(ctx context.Context, owner, state, cursor string) (inbox.Page, error) {
	return inbox.List(ctx, s.pool, owner, state, cursor)
}
func (s *Store) AttentionRequest(ctx context.Context, owner, id string) (inbox.Request, error) {
	return inbox.Get(ctx, s.pool, owner, id)
}
func (s *Store) HandleAttentionRequest(ctx context.Context, owner, id string, h inbox.Handle, close bool) (inbox.Request, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return inbox.Request{}, err
	}
	defer tx.Rollback(ctx)
	r, changed, err := inbox.Process(ctx, tx, owner, id, h, close)
	if err != nil {
		return r, err
	}
	if changed && r.Source == "agent" {
		payload := map[string]any{"request_id": r.ID, "title": r.Title, "state": r.State, "resolution": r.Resolution}
		if err = insertProjectInput(ctx, tx, owner, r.AgentID, "attention_answer", "attention:"+r.ID+":resolution", payload); err != nil {
			return r, err
		}
	}
	if err = s.runBeforeCommit(ctx); err != nil {
		return r, err
	}
	return r, tx.Commit(ctx)
}

func taskSnapshot(ctx context.Context, tx pgx.Tx, owner, project, id string) (json.RawMessage, *int, error) {
	rec, _, found, err := loadTask(ctx, tx, ` WHERE employee_id=$1 AND project_id=$2 AND id=$3 FOR SHARE`, owner, project, id)
	if err != nil {
		return nil, nil, err
	}
	if !found {
		return nil, nil, inbox.ErrNotFound
	}
	return snapshotRecord(ctx, tx, owner, rec)
}
func snapshotRecord(ctx context.Context, tx pgx.Tx, owner string, rec task.Record) (json.RawMessage, *int, error) {
	loaded := []task.Record{rec}
	if err := attachResults(ctx, tx, owner, loaded); err != nil {
		return nil, nil, err
	}
	rec = loaded[0]
	raw, err := json.Marshal(struct {
		TaskID               string           `json:"task_id"`
		TargetNodeID         string           `json:"target_node_id"`
		EvidenceEmptyReason  *string          `json:"evidence_empty_reason,omitempty"`
		ArtifactsEmptyReason *string          `json:"artifacts_empty_reason,omitempty"`
		Version              int              `json:"version"`
		Status               string           `json:"status"`
		Summary              *string          `json:"summary"`
		ErrorCode            *string          `json:"error_code"`
		ErrorMessage         *string          `json:"error_message"`
		Evidence             []task.ResultRef `json:"evidence"`
		Artifacts            []task.ResultRef `json:"artifacts"`
	}{TaskID: rec.TaskID, TargetNodeID: rec.TargetNodeID, Version: rec.Version, Status: rec.Status, Summary: rec.Summary, ErrorCode: rec.ErrorCode, ErrorMessage: rec.ErrorMessage, Evidence: rec.Evidence, Artifacts: rec.Artifacts, EvidenceEmptyReason: rec.EvidenceEmptyReason, ArtifactsEmptyReason: rec.ArtifactsEmptyReason})
	return raw, &rec.Version, err
}

// syncTaskAttention 在持有任务锁的状态变更事务内调用，不取得 Agent 锁。
func syncTaskAttention(ctx context.Context, tx pgx.Tx, owner, id, previous string) error {
	rec, _, found, err := loadTask(ctx, tx, ` WHERE employee_id=$1 AND id=$2`, owner, id)
	if err != nil {
		return err
	}
	if !found || rec.Status == previous {
		return nil
	}
	if rec.Status != task.StatusNeedsVerification {
		if previous == task.StatusNeedsVerification {
			return inbox.ResolveSystem(ctx, tx, inbox.TaskNeedsVerification, id)
		}
		return nil
	}
	var b inbox.Binding
	// 与 Project 归档串行，归档提交后不再留下新建的待处理事项。
	err = tx.QueryRow(ctx, `SELECT p.employee_id::text,p.id::text,a.id::text,c.id::text FROM tasks t JOIN projects p ON p.id=t.project_id AND p.employee_id=t.employee_id JOIN project_agents a ON a.project_id=p.id JOIN conversations c ON c.agent_id=a.id WHERE t.id=$1 AND p.status<>'archived' FOR SHARE OF p`, id).Scan(&b.EmployeeID, &b.ProjectID, &b.AgentID, &b.ConversationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	snapshot, version, err := snapshotRecord(ctx, tx, owner, rec)
	if err != nil {
		return err
	}
	reason := "任务的执行结果或副作用需要人工核实"
	if rec.ErrorMessage != nil && *rec.ErrorMessage != "" {
		reason = *rec.ErrorMessage
	}
	return inbox.CreateSystem(ctx, tx, b, inbox.TaskNeedsVerification, id, "任务需要核实", reason, id, version, snapshot)
}

func (s *Store) executeInboxTool(ctx context.Context, tx pgx.Tx, b projectRunBinding, callID, name string, a toolArguments) (any, error) {
	binding := inboxBinding(b)
	switch name {
	case "inbox.ask":
		ask := inbox.Ask{Title: a.Title, Summary: a.Summary, Content: a.Content, Options: a.Options, AllowText: a.AllowText, TaskID: a.TaskID}
		if err := ask.Validate(); err != nil {
			return nil, err
		}
		var snapshot json.RawMessage
		var version *int
		var err error
		if a.TaskID != "" {
			snapshot, version, err = taskSnapshot(ctx, tx, b.owner, b.projectID, a.TaskID)
			if err != nil {
				return nil, err
			}
		}
		r, err := inbox.CreateAgent(ctx, tx, binding, callID, ask, version, snapshot)
		if err != nil {
			return nil, err
		}
		return map[string]any{"request_id": r.ID, "state": r.State, "version": r.Version, "read_tool": "inbox.get"}, nil
	case "inbox.get":
		if a.RequestID == "" {
			return nil, inbox.ErrInvalid
		}
		r, err := inbox.Get(ctx, tx, b.owner, a.RequestID)
		if err != nil {
			return nil, err
		}
		if r.ProjectID != b.projectID {
			return nil, inbox.ErrNotFound
		}
		return toolJSONPage(r, a)
	case "inbox.list":
		items, err := inbox.ListProject(ctx, tx, binding, a.AfterID)
		if err != nil {
			return nil, err
		}
		summaries := []any{}
		last := ""
		for _, r := range items {
			last = r.ID
			summaries = append(summaries, map[string]any{"request_id": r.ID, "title": r.Title, "source": r.Source, "state": r.State, "version": r.Version, "task_id": r.TaskID, "created_at": r.CreatedAt, "resolution": r.Resolution})
		}
		return toolJSONPage(map[string]any{"requests": summaries, "next_after_id": last}, a)
	case "inbox.withdraw":
		if a.RequestID == "" {
			return nil, inbox.ErrInvalid
		}
		r, err := inbox.Withdraw(ctx, tx, binding, a.RequestID, a.Reason)
		if err != nil {
			return nil, err
		}
		// 完整处理内容可由 inbox.get 分页读取。
		out := map[string]any{"request_id": r.ID, "state": r.State, "version": r.Version, "resolution": r.Resolution, "read_tool": "inbox.get"}
		raw, err := protocol.MarshalJSON(out)
		if err != nil {
			return nil, err
		}
		if len(raw) > 12<<10 {
			delete(out, "resolution")
			out["truncated"] = true
		}
		return out, nil
	}
	return nil, inbox.ErrInvalid
}
