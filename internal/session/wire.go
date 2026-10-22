package session

import (
	"encoding/json"
	"errors"

	"baton/internal/protocol"
)

var (
	ErrSessionOwned = errors.New("已有 Worker 接管该 Thread")
	errEndpointBusy = errors.New("Thread Worker 已在监听")
)

// ThreadCommandError 表示 Worker 明确拒绝命令，Host 不因此重启进程。
type ThreadCommandError struct{ Message string }

func (e *ThreadCommandError) Error() string { return e.Message }

type ipcMessage struct {
	ClientMessageID string                   `json:"client_message_id,omitempty"`
	Mode            string                   `json:"mode,omitempty"`
	Model           string                   `json:"model,omitempty"`
	AfterWorkerSeq  int64                    `json:"after_worker_seq,omitempty"`
	WorkerSeq       int64                    `json:"worker_seq,omitempty"`
	ThreadReports   []protocol.ThreadReport  `json:"thread_reports,omitempty"`
	SessionRequest  *protocol.SessionRequest `json:"session_request,omitempty"`
	SessionResult   *protocol.SessionResult  `json:"session_result,omitempty"`
	History         json.RawMessage          `json:"history,omitempty"`
	HistoryCursor   string                   `json:"history_cursor,omitempty"`
	StopReason      string                   `json:"stop_reason,omitempty"`
	Type            string                   `json:"type"`
	Token           string                   `json:"token,omitempty"`
	OK              bool                     `json:"ok"`
	Code            string                   `json:"code,omitempty"`
	Message         string                   `json:"message,omitempty"`
	PID             int                      `json:"pid,omitempty"`
	SessionID       string                   `json:"session_id,omitempty"`
	Payload         string                   `json:"payload,omitempty"`
	EventID         string                   `json:"event_id,omitempty"`
}

// Status 是 Worker 对一次本地查询的回答。
type Status struct {
	ThreadReports []protocol.ThreadReport
	SessionResult *protocol.SessionResult
	History       json.RawMessage
	HistoryCursor string
	PID           int
	SessionID     string
}
