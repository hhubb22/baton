package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// ThreadError 携带可公开的业务错误，不包含节点输出。
type ThreadError struct {
	Code          string `json:"code"`
	Message       string `json:"message"`
	Status        int    `json:"-"`
	CurrentStatus string `json:"current_status,omitempty"`
}

func (e *ThreadError) Error() string { return e.Message }
func threadError(status int, code, message string) error {
	return &ThreadError{Code: code, Message: message, Status: status}
}
func threadConflict() error {
	return threadError(409, "conflict", "同一标识的内容不同或操作与当前状态冲突")
}
func threadInvalid() error { return threadError(400, "invalid_request", "Thread 请求无效") }

type Thread struct {
	NextModel               string     `json:"next_model,omitempty"`
	ID                      string     `json:"id"`
	EmployeeID              string     `json:"employee_id"`
	ClientThreadID          string     `json:"client_thread_id"`
	ProjectID               string     `json:"project_id,omitempty"`
	OriginConversationID    string     `json:"origin_conversation_id,omitempty"`
	OriginToolCallID        string     `json:"origin_tool_call_id,omitempty"`
	NodeID                  string     `json:"node_id"`
	AgentType               string     `json:"agent_type"`
	Model                   string     `json:"model"`
	WorkingDirectory        string     `json:"working_directory"`
	ExecutionTimeoutSeconds int        `json:"execution_timeout_seconds"`
	Status                  string     `json:"status"`
	StatusReason            string     `json:"status_reason"`
	CreatedBy               string     `json:"created_by"`
	StorageGeneration       string     `json:"storage_generation,omitempty"`
	NativeSessionID         string     `json:"native_session_id,omitempty"`
	OpenedAt                *time.Time `json:"opened_at,omitempty"`
	ArchivedAt              *time.Time `json:"archived_at,omitempty"`
	ArchiveRequestedAt      *time.Time `json:"archive_requested_at,omitempty"`
	StopRequestedAt         *time.Time `json:"stop_requested_at,omitempty"`
	StopConfirmedAt         *time.Time `json:"stop_confirmed_at,omitempty"`
	LastReportedAt          *time.Time `json:"last_reported_at,omitempty"`
	LastWorkerSeq           int64      `json:"last_worker_seq"`
	Version                 int64      `json:"version"`
	CreatedAt               time.Time  `json:"created_at"`
	LastActivityAt          time.Time  `json:"last_activity_at"`
	NodeOnline              bool       `json:"node_online"`
	NodeSynced              bool       `json:"node_synced"`
	NodeLastContactAt       *time.Time `json:"node_last_contact_at,omitempty"`
}
type ThreadMessageInput struct {
	ClientMessageID  string `json:"client_message_id"`
	Content          string `json:"content"`
	Mode             string `json:"mode,omitempty"`
	Model            string `json:"model"`
	Sender           string `json:"-"`
	OriginToolCallID string `json:"-"`
}
type CreateThreadInput struct {
	ClientThreadID          string             `json:"client_thread_id"`
	NodeID                  string             `json:"node_id,omitempty"`
	AgentType               string             `json:"agent_type"`
	Model                   string             `json:"model"`
	WorkingDirectory        string             `json:"working_directory"`
	ProjectID               string             `json:"project_id,omitempty"`
	ExecutionTimeoutSeconds int                `json:"execution_timeout_seconds,omitempty"`
	Message                 ThreadMessageInput `json:"message"`
	CreatedBy               string             `json:"-"`
	OriginConversationID    string             `json:"-"`
	OriginToolCallID        string             `json:"-"`
}
type ThreadMessage struct {
	RequestedModel   string    `json:"requested_model,omitempty"`
	ID               string    `json:"id"`
	ThreadID         string    `json:"thread_id"`
	ClientMessageID  string    `json:"client_message_id"`
	Sender           string    `json:"sender"`
	OriginToolCallID string    `json:"origin_tool_call_id,omitempty"`
	Content          string    `json:"content"`
	Mode             string    `json:"mode"`
	Model            string    `json:"model"`
	Status           string    `json:"status"`
	StatusReason     string    `json:"status_reason"`
	TurnID           string    `json:"turn_id,omitempty"`
	WorkerTurnSeq    *int64    `json:"worker_turn_seq,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
}
type ThreadTurn struct {
	ID               string     `json:"id"`
	ThreadID         string     `json:"thread_id"`
	WorkerTurnSeq    int64      `json:"worker_turn_seq"`
	Initiator        string     `json:"initiator"`
	Model            string     `json:"model"`
	OriginToolCallID string     `json:"origin_tool_call_id,omitempty"`
	StartedAt        time.Time  `json:"started_at"`
	EndedAt          *time.Time `json:"ended_at,omitempty"`
	EndReason        string     `json:"end_reason,omitempty"`
}
type ThreadView struct {
	ResumePending bool `json:"resume_pending"`
	Thread
	CurrentTurn     *ThreadTurn     `json:"current_turn"`
	PendingMessages []ThreadMessage `json:"pending_messages"`
	FailedMessages  []ThreadMessage `json:"failed_messages"`
}
type ThreadFilter struct {
	ProjectID, NodeID, Status, Cursor string
	Limit                             int
}
type ThreadPage struct {
	Threads    []Thread `json:"threads"`
	NextCursor string   `json:"next_cursor,omitempty"`
}
type ThreadEvent struct {
	ID        int64           `json:"id"`
	Kind      string          `json:"kind"`
	Actor     string          `json:"actor"`
	ActorID   string          `json:"actor_id"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"created_at"`
}
type ThreadTimeline struct {
	Events     []ThreadEvent `json:"events"`
	NextCursor string        `json:"next_cursor,omitempty"`
}

const threadJSON = `to_jsonb(t)-'request_hash' || jsonb_build_object('node_online',COALESCE(p.online,false),'node_synced',COALESCE(p.synced,false),'node_last_contact_at',p.last_contact_at)`

func readThread(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, employeeID, id string, lock bool) (Thread, error) {
	var t Thread
	var raw []byte
	suffix := ""
	if lock {
		suffix = " FOR UPDATE OF t"
	}
	err := q.QueryRow(ctx, `SELECT `+threadJSON+` FROM threads t LEFT JOIN node_presence p ON p.node_id=t.node_id WHERE t.employee_id=$1::uuid AND t.id=$2::uuid`+suffix, employeeID, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return t, ErrNotFound
	}
	if err == nil {
		err = json.Unmarshal(raw, &t)
	}
	return t, err
}
func threadAudit(ctx context.Context, tx pgx.Tx, t Thread, kind, actor, actorID string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO thread_events(employee_id,thread_id,kind,actor,actor_id,payload) VALUES($1,$2,$3,$4,$5,$6)`, t.EmployeeID, t.ID, kind, actor, actorID, raw)
	return err
}
func touchThread(ctx context.Context, tx pgx.Tx, id string) error {
	_, err := tx.Exec(ctx, `UPDATE threads SET version=version+1,last_activity_at=clock_timestamp() WHERE id=$1`, id)
	return err
}
