package store

import (
	"context"

	"baton/internal/inbox"
	"baton/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func inboxBinding(b projectRunBinding) inbox.Binding {
	return inbox.Binding{EmployeeID: b.owner, ProjectID: b.projectID, AgentID: b.agentID, ConversationID: b.conversationID}
}
func (s *Store) Inbox(ctx context.Context, owner, state, cursor string) (inbox.Page, error) {
	return inbox.List(ctx, s.pool, owner, state, cursor)
}
func (s *Store) RelatedAttentionRequests(ctx context.Context, owner, state, cursor, projectID, threadID string) (inbox.Page, error) {
	return inbox.ListFiltered(ctx, s.pool, owner, state, cursor, projectID, threadID)
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

func (s *Store) executeInboxTool(ctx context.Context, tx pgx.Tx, b projectRunBinding, callID, name string, a toolArguments) (any, error) {
	binding := inboxBinding(b)
	switch name {
	case "inbox.ask":
		ask := inbox.Ask{Title: a.Title, Content: a.Content, Options: a.Options, AllowText: a.AllowText, ThreadID: a.ThreadID}
		r, err := inbox.CreateAgent(ctx, tx, binding, callID, ask)
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
			summaries = append(summaries, map[string]any{"request_id": r.ID, "title": r.Title, "source": r.Source, "state": r.State, "version": r.Version, "thread_id": r.ThreadID, "created_at": r.CreatedAt, "resolution": r.Resolution})
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
