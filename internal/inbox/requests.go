package inbox

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"baton/internal/identity"
	"github.com/jackc/pgx/v5"
)

type Queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}
type Binding struct{ EmployeeID, ProjectID, AgentID, ConversationID string }

const requestSelect = `SELECT r.id::text,r.employee_id::text,r.project_id::text,p.title,r.agent_id::text,r.conversation_id::text,
 COALESCE(r.origin_tool_call_id,''),r.source,COALESCE(r.condition_type,''),COALESCE(r.condition_object_id::text,''),COALESCE(r.task_id::text,''),
 r.title,r.summary,r.content,r.options,r.allow_text,r.task_result_version,r.task_result,t.version,t.updated_at,
 r.action_url,r.state,r.version,r.resolution,r.resolved_at,r.withdraw_reason,r.created_at,r.updated_at
 FROM attention_requests r JOIN projects p ON p.id=r.project_id
 LEFT JOIN tasks t ON t.id=r.task_id AND t.employee_id=r.employee_id`

func scan(row pgx.Row) (Request, error) {
	var r Request
	err := row.Scan(&r.ID, &r.EmployeeID, &r.ProjectID, &r.ProjectTitle, &r.AgentID, &r.ConversationID, &r.OriginToolCallID, &r.Source, &r.ConditionType, &r.ConditionObjectID, &r.TaskID,
		&r.Title, &r.Summary, &r.Content, &r.Options, &r.AllowText, &r.TaskResultVersion, &r.TaskResult, &r.LatestTaskResultVersion, &r.LatestTaskResultUpdatedAt,
		&r.ActionURL, &r.State, &r.Version, &r.Resolution, &r.ResolvedAt, &r.WithdrawReason, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return r, err
}
func Get(ctx context.Context, q Queryer, owner, id string) (Request, error) {
	return scan(q.QueryRow(ctx, requestSelect+` WHERE r.employee_id=$1 AND r.id=$2`, owner, id))
}

// CreateAgent 的调用方持有 Agent 行锁，并已锁定关联任务和取得结果快照。
func CreateAgent(ctx context.Context, tx pgx.Tx, b Binding, callID string, a Ask, version *int, snapshot json.RawMessage) (Request, error) {
	if err := a.Validate(); err != nil {
		return Request{}, err
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM attention_requests WHERE project_id=$1 AND source='agent' AND state='open'`, b.ProjectID).Scan(&count); err != nil {
		return Request{}, err
	}
	if count >= 10 {
		return Request{}, ErrLimit
	}
	id, err := identity.NewUUID()
	if err != nil {
		return Request{}, err
	}
	if a.Options == nil {
		a.Options = []Option{}
	}
	_, err = tx.Exec(ctx, `INSERT INTO attention_requests(id,employee_id,project_id,agent_id,conversation_id,origin_tool_call_id,source,task_id,task_result_version,task_result,title,summary,content,options,allow_text)
 VALUES($1,$2,$3,$4,$5,$6,'agent',$7,$8,$9,$10,$11,$12,$13,$14)`, id, b.EmployeeID, b.ProjectID, b.AgentID, b.ConversationID, callID, nullable(a.TaskID), version, snapshot, a.Title, a.Summary, a.Content, a.Options, a.AllowText)
	if err != nil {
		return Request{}, err
	}
	return Get(ctx, tx, b.EmployeeID, id)
}
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func lock(ctx context.Context, tx pgx.Tx, owner, id string) (Request, error) {
	var locked string
	err := tx.QueryRow(ctx, `SELECT id::text FROM attention_requests WHERE employee_id=$1 AND id=$2 FOR UPDATE`, owner, id).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, ErrNotFound
	}
	if err != nil {
		return Request{}, err
	}
	return Get(ctx, tx, owner, id)
}
func Withdraw(ctx context.Context, tx pgx.Tx, b Binding, id, reason string) (Request, error) {
	if !validText(reason, 1, 200) {
		return Request{}, ErrInvalid
	}
	r, err := lock(ctx, tx, b.EmployeeID, id)
	if err != nil {
		return r, err
	}
	if r.ProjectID != b.ProjectID {
		return Request{}, ErrNotFound
	}
	if r.Source != "agent" {
		return r, ErrInvalid
	}
	if r.State != "open" {
		return r, nil
	}
	_, err = tx.Exec(ctx, `UPDATE attention_requests SET state='withdrawn',version=version+1,withdraw_reason=$2,resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, id, reason)
	if err != nil {
		return r, err
	}
	return Get(ctx, tx, b.EmployeeID, id)
}

// Process 返回 changed；重试只返回原记录，不重复写入输入。
func Process(ctx context.Context, tx pgx.Tx, owner, id string, h Handle, close bool) (r Request, changed bool, err error) {
	if err = h.Validate(close); err != nil {
		return
	}
	r, err = lock(ctx, tx, owner, id)
	if err != nil {
		return
	}
	if r.Resolution != nil && r.Resolution.ClientRequestID == h.ClientRequestID {
		return r, false, nil
	}
	if r.State != "open" || r.Version != h.ExpectedVersion {
		return r, false, &Conflict{r}
	}
	if !close && r.Source == "system" {
		return r, false, ErrInvalid
	}
	resolution := Resolution{ClientRequestID: h.ClientRequestID, EmployeeID: owner, OptionID: h.OptionID, Text: h.Text}
	state := "closed"
	if !close {
		state = "answered"
		if h.OptionID != "" {
			for _, o := range r.Options {
				if o.ID == h.OptionID {
					resolution.OptionLabel = o.Label
				}
			}
			if resolution.OptionLabel == "" {
				return r, false, ErrInvalid
			}
		} else if !r.AllowText || strings.TrimSpace(h.Text) == "" {
			return r, false, ErrInvalid
		}
	}
	_, err = tx.Exec(ctx, `UPDATE attention_requests SET state=$2,resolution=$3,version=version+1,resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, id, state, resolution)
	if err != nil {
		return r, false, err
	}
	r, err = Get(ctx, tx, owner, id)
	return r, err == nil, err
}
func Archive(ctx context.Context, tx pgx.Tx, project string) error {
	_, err := tx.Exec(ctx, `UPDATE attention_requests SET state='withdrawn',version=version+1,withdraw_reason='Project 已归档',resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE project_id=$1 AND state='open'`, project)
	return err
}

const ProjectNeedsAttention = "project_needs_attention"
const TaskNeedsVerification = "task_needs_verification"

// CreateSystem 只由进入两种系统条件的状态变化调用；关闭后继续处于该状态不会调用这里。
func CreateSystem(ctx context.Context, tx pgx.Tx, b Binding, condition, object, title, reason, taskID string, version *int, snapshot json.RawMessage) error {
	if condition != ProjectNeedsAttention && condition != TaskNeedsVerification {
		return ErrInvalid
	}
	id, err := identity.NewUUID()
	if err != nil {
		return err
	}
	path := "/projects/" + b.ProjectID
	if taskID != "" {
		path = "/tasks/" + taskID
	}
	// 详情保留完整原因，摘要仅用于列表显示。
	summary := []rune(reason)
	if len(summary) > 280 {
		summary = summary[:280]
	}
	_, err = tx.Exec(ctx, `INSERT INTO attention_requests(id,employee_id,project_id,agent_id,conversation_id,source,condition_type,condition_object_id,task_id,task_result_version,task_result,title,summary,content,action_url)
 VALUES($1,$2,$3,$4,$5,'system',$6,$7,$8,$9,$10,$11,$12,$13,$14)
 ON CONFLICT(condition_type,condition_object_id) WHERE source='system' AND state='open' DO NOTHING`, id, b.EmployeeID, b.ProjectID, b.AgentID, b.ConversationID, condition, object, nullable(taskID), version, snapshot, title, string(summary), reason, path)
	return err
}
func ResolveSystem(ctx context.Context, tx pgx.Tx, condition, object string) error {
	_, err := tx.Exec(ctx, `UPDATE attention_requests SET state='resolved',version=version+1,resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE source='system' AND condition_type=$1 AND condition_object_id=$2 AND state='open'`, condition, object)
	return err
}

type Page struct {
	Requests   []Request `json:"requests"`
	OpenCount  int       `json:"open_count"`
	NextCursor string    `json:"next_cursor,omitempty"`
}
type cursor struct {
	CreatedAt time.Time `json:"at"`
	ID        string    `json:"id"`
}

func List(ctx context.Context, q Queryer, owner, state, encoded string) (Page, error) {
	return ListFiltered(ctx, q, owner, state, encoded, "", "")
}

// ListFiltered 按归属筛选页面中的相关事项，员工边界始终由 owner 限定。
func ListFiltered(ctx context.Context, q Queryer, owner, state, encoded, projectID, taskID string) (Page, error) {
	out := Page{Requests: []Request{}}
	for _, id := range []string{projectID, taskID} {
		if id != "" {
			if _, err := identity.ParseUUID(id); err != nil {
				return out, ErrInvalid
			}
		}
	}
	if state == "" {
		state = "open"
	}
	if state != "open" && state != "done" && state != "all" {
		return out, ErrInvalid
	}
	var c cursor
	if encoded != "" {
		raw, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil || json.Unmarshal(raw, &c) != nil || c.CreatedAt.IsZero() {
			return out, ErrInvalid
		}
		if _, err := identity.ParseUUID(c.ID); err != nil {
			return out, ErrInvalid
		}
	}
	if err := q.QueryRow(ctx, `SELECT count(*) FROM attention_requests WHERE employee_id=$1 AND state='open'`, owner).Scan(&out.OpenCount); err != nil {
		return out, err
	}
	rows, err := q.Query(ctx, requestSelect+` WHERE r.employee_id=$1 AND (($2='all') OR ($2='open' AND r.state='open') OR ($2='done' AND r.state<>'open')) AND ($3::uuid IS NULL OR (r.created_at,r.id)<($4,$3)) AND ($5::uuid IS NULL OR r.project_id=$5) AND ($6::uuid IS NULL OR r.task_id=$6) ORDER BY r.created_at DESC,r.id DESC LIMIT 51`, owner, state, nullable(c.ID), c.CreatedAt, nullable(projectID), nullable(taskID))
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		r, err := scan(rows)
		if err != nil {
			return out, err
		}
		if len(out.Requests) == 50 {
			last := out.Requests[49]
			raw, _ := json.Marshal(cursor{last.CreatedAt, last.ID})
			out.NextCursor = base64.RawURLEncoding.EncodeToString(raw)
			break
		}
		out.Requests = append(out.Requests, r)
	}
	return out, rows.Err()
}
func ListProject(ctx context.Context, q Queryer, b Binding, after string) ([]Request, error) {
	rows, err := q.Query(ctx, requestSelect+` WHERE r.employee_id=$1 AND r.project_id=$2 AND ($3::uuid IS NULL OR r.id>$3) ORDER BY r.id LIMIT 20`, b.EmployeeID, b.ProjectID, nullable(after))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Request{}
	for rows.Next() {
		r, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
