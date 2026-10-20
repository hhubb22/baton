package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"

	"baton/internal/identity"
	"baton/internal/inbox"
	"baton/internal/projectagent"

	"github.com/jackc/pgx/v5"
)

const projectSelect = `SELECT p.id::text, p.title, p.goal, p.status, p.version, p.created_at, p.updated_at,
    a.id::text, a.provider, a.model, c.id::text, c.state, c.next_seq - 1
    FROM projects p JOIN project_agents a ON a.employee_id=p.employee_id AND a.project_id=p.id
    JOIN conversations c ON c.employee_id=a.employee_id AND c.agent_id=a.id AND c.kind='primary'`

func nullableProjectID(id string) any {
	if id == "" {
		return nil
	}
	return id
}

func scanProject(row pgx.Row) (projectagent.Project, error) {
	var p projectagent.Project
	err := row.Scan(&p.ID, &p.Title, &p.Goal, &p.Status, &p.Version, &p.CreatedAt, &p.UpdatedAt,
		&p.Agent.ID, &p.Agent.Provider, &p.Agent.Model, &p.Conversation.ID, &p.Conversation.State, &p.Conversation.LastSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return p, err
}

func (s *Store) CreateProject(ctx context.Context, employeeID string, in projectagent.CreateInput) (projectagent.Project, error) {
	p := projectagent.Project{Title: in.Title, Goal: in.Goal, Status: "active", Agent: projectagent.Agent{Provider: in.Provider, Model: in.Model}}
	if err := p.Validate(); err != nil {
		return p, err
	}
	var err error
	if p.ID, err = identity.NewUUID(); err != nil {
		return p, err
	}
	if p.Agent.ID, err = identity.NewUUID(); err != nil {
		return p, err
	}
	if p.Conversation.ID, err = identity.NewUUID(); err != nil {
		return p, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return p, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `INSERT INTO projects(id, employee_id, title, goal) VALUES($1,$2,$3,$4)`,
		p.ID, employeeID, p.Title, p.Goal); err != nil {
		return p, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO project_agents(id, employee_id, project_id, provider, model) VALUES($1,$2,$3,$4,$5)`,
		p.Agent.ID, employeeID, p.ID, in.Provider, in.Model); err != nil {
		return p, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO conversations(id, employee_id, agent_id) VALUES($1,$2,$3)`,
		p.Conversation.ID, employeeID, p.Agent.ID); err != nil {
		return p, err
	}
	p, err = scanProject(tx.QueryRow(ctx, projectSelect+` WHERE p.employee_id=$1 AND p.id=$2`, employeeID, p.ID))
	if err != nil {
		return p, err
	}
	return p, tx.Commit(ctx)
}

func (s *Store) Project(ctx context.Context, employeeID, projectID string) (projectagent.Project, error) {
	return scanProject(s.pool.QueryRow(ctx, projectSelect+` WHERE p.employee_id=$1 AND p.id=$2`, employeeID, projectID))
}

// ListProjects 以稳定 ID 分页，每页最多 100 条。
func (s *Store) ListProjects(ctx context.Context, employeeID, afterID string, limit int) ([]projectagent.Project, error) {
	if limit < 1 || limit > 100 {
		return nil, projectagent.ErrInvalid
	}
	rows, err := s.pool.Query(ctx, projectSelect+` WHERE p.employee_id=$1 AND ($2::uuid IS NULL OR p.id>$2::uuid) ORDER BY p.id LIMIT $3`, employeeID, nullableProjectID(afterID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []projectagent.Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) PatchProject(ctx context.Context, employeeID, projectID string, patch projectagent.Patch) (projectagent.Project, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return projectagent.Project{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Project 写入先锁 Agent，与后续运行路径的锁顺序一致。
	var agentID string
	err = tx.QueryRow(ctx, `SELECT id::text FROM project_agents WHERE employee_id=$1 AND project_id=$2 FOR NO KEY UPDATE`, employeeID, projectID).Scan(&agentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return projectagent.Project{}, ErrNotFound
	}
	if err != nil {
		return projectagent.Project{}, err
	}
	p, err := scanProject(tx.QueryRow(ctx, projectSelect+` WHERE p.employee_id=$1 AND p.id=$2`, employeeID, projectID))
	if err != nil {
		return p, err
	}
	oldTitle, oldGoal := p.Title, p.Goal
	if patch.Title != nil {
		p.Title = *patch.Title
	}
	if patch.Goal != nil {
		p.Goal = *patch.Goal
	}
	if patch.Status != nil {
		p.Status = *patch.Status
	}
	if patch.Provider != nil {
		p.Agent.Provider = *patch.Provider
	}
	if patch.Model != nil {
		p.Agent.Model = *patch.Model
	}
	if err = p.Validate(); err != nil {
		return p, err
	}
	if _, err = tx.Exec(ctx, `UPDATE projects SET title=$3, goal=$4, status=$5, version=version+1, updated_at=clock_timestamp()
        WHERE employee_id=$1 AND id=$2`, employeeID, projectID, p.Title, p.Goal, p.Status); err != nil {
		return p, err
	}
	if _, err = tx.Exec(ctx, `UPDATE project_agents SET provider=$2, model=$3 WHERE id=$1`, agentID, p.Agent.Provider, p.Agent.Model); err != nil {
		return p, err
	}
	p, err = scanProject(tx.QueryRow(ctx, projectSelect+` WHERE p.employee_id=$1 AND p.id=$2`, employeeID, projectID))
	if err != nil {
		return p, err
	}
	if p.Title != oldTitle || p.Goal != oldGoal {
		if err = insertProjectInput(ctx, tx, employeeID, agentID, "project_updated", fmt.Sprintf("project:%s:version:%d", projectID, p.Version), projectUpdatedPayload(p)); err != nil {
			return p, err
		}
	}
	if p.Status == "archived" {
		if err = inbox.Archive(ctx, tx, projectID); err != nil {
			return p, err
		}
	}
	if p.Status != "active" {
		if err = releaseProjectRun(ctx, tx, agentID, "finished", "project_"+p.Status); err != nil {
			return p, err
		}
	}
	return p, tx.Commit(ctx)
}

// AcceptProjectMessage 只写中心队列，设备状态不参与接受。重发返回原记录。
func (s *Store) AcceptProjectMessage(ctx context.Context, employeeID, projectID string, in projectagent.MessageInput) (projectagent.Message, error) {
	var out projectagent.Message
	if err := in.Validate(); err != nil {
		return out, err
	}
	p, err := s.Project(ctx, employeeID, projectID)
	if err != nil {
		return out, err
	}
	payload, err := json.Marshal(struct {
		Content string `json:"content"`
	}{in.Content})
	if err != nil {
		return out, err
	}
	digest := sha256.Sum256([]byte(in.Content))
	// jsonb 会把 JSON 转义转换成规范文本；队列仍遵守 72 KiB 的数据库上限。
	var fits bool
	if err = s.pool.QueryRow(ctx, `SELECT octet_length($1::jsonb::text)<=73728`, payload).Scan(&fits); err != nil {
		return out, err
	}
	if !fits {
		return out, projectagent.ErrTooLarge
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sourceKey := "user:" + in.ClientMessageID
	err = tx.QueryRow(ctx, `INSERT INTO project_agent_input_queue(employee_id, agent_id, source_type, source_key, payload, payload_hash, wake_required)
        VALUES($1,$2,'user_message',$3,$4,$5,true) ON CONFLICT(agent_id, source_key) DO NOTHING
        RETURNING id, payload->>'content', created_at`, employeeID, p.Agent.ID, sourceKey, payload, digest[:]).Scan(&out.ID, &out.Content, &out.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `SELECT id, payload->>'content', created_at FROM project_agent_input_queue
            WHERE employee_id=$1 AND agent_id=$2 AND source_key=$3 AND source_type='user_message'`, employeeID, p.Agent.ID, sourceKey).Scan(&out.ID, &out.Content, &out.CreatedAt)
		if err == nil && out.Content != in.Content {
			return projectagent.Message{}, projectagent.ErrMessageConflict
		}
	}
	if err != nil {
		return out, err
	}
	out.ClientMessageID = in.ClientMessageID
	return out, tx.Commit(ctx)
}

func (s *Store) ProjectEvents(ctx context.Context, employeeID, projectID string, afterSeq int64, limit int) (projectagent.EventPage, error) {
	out := projectagent.EventPage{Events: []projectagent.Event{}, NextAfterSeq: afterSeq}
	if afterSeq < 0 || limit < 1 || limit > 100 {
		return out, projectagent.ErrInvalid
	}
	p, err := s.Project(ctx, employeeID, projectID)
	if err != nil {
		return out, err
	}
	out.LastSeq = p.Conversation.LastSeq
	rows, err := s.pool.Query(ctx, `SELECT conversation_id::text, seq, kind, client_event_id, tool_call_id, run_id::text, lease_epoch, payload, created_at
        FROM conversation_events WHERE employee_id=$1 AND conversation_id=$2 AND seq>$3 AND seq<=$4 ORDER BY seq LIMIT $5`,
		employeeID, p.Conversation.ID, afterSeq, out.LastSeq, limit)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	size := 0
	for rows.Next() {
		var e projectagent.Event
		if err = rows.Scan(&e.ConversationID, &e.Seq, &e.Kind, &e.ClientEventID, &e.ToolCallID, &e.RunID, &e.LeaseEpoch, &e.Payload, &e.CreatedAt); err != nil {
			return out, err
		}
		raw, err := json.Marshal(e)
		if err != nil {
			return out, err
		}
		// 单条事件总能读取；JSON 转义可能让响应大于数据库中的 payload。
		if len(out.Events) > 0 && size+len(raw) > projectagent.MaxEventPageBytes {
			break
		}
		size += len(raw)
		out.Events = append(out.Events, e)
		out.NextAfterSeq = e.Seq
	}
	out.HasMore = out.NextAfterSeq < out.LastSeq
	return out, rows.Err()
}
