package protocol

import "encoding/json"

const (
	BodyThreadCommand       = "thread.command"
	BodyThreadCommandResult = "thread.command_result"
	BodyThreadReport        = "thread.report"
	BodyThreadReportResult  = "thread.report_result"
)

// ThreadCommand 的 MessageID 在信封中；重试沿用同一标识。
type ThreadCommand struct {
	Type                    string `json:"type"`
	ThreadID                string `json:"thread_id"`
	Action                  string `json:"action"`
	StorageGeneration       string `json:"storage_generation,omitempty"`
	AgentType               string `json:"agent_type,omitempty"`
	Model                   string `json:"model,omitempty"`
	WorkingDirectory        string `json:"working_directory,omitempty"`
	ExecutionTimeoutSeconds int    `json:"execution_timeout_seconds,omitempty"`
	ClientMessageID         string `json:"client_message_id,omitempty"`
	Content                 string `json:"content,omitempty"`
	Mode                    string `json:"mode,omitempty"`
}

type ThreadCommandResult struct {
	Type     string `json:"type"`
	ThreadID string `json:"thread_id"`
	OK       bool   `json:"ok"`
	Code     string `json:"code,omitempty"`
}

// ThreadReport 的 WorkerSeq 覆盖该 Worker 的全部报告，WorkerTurnSeq 标识一轮。
type ThreadReport struct {
	Type              string          `json:"type"`
	ThreadID          string          `json:"thread_id"`
	EventID           string          `json:"event_id"`
	WorkerSeq         int64           `json:"worker_seq"`
	Kind              string          `json:"kind"`
	WorkerTurnSeq     int64           `json:"worker_turn_seq,omitempty"`
	ClientMessageID   string          `json:"client_message_id,omitempty"`
	StorageGeneration string          `json:"storage_generation,omitempty"`
	NativeSessionID   string          `json:"native_session_id,omitempty"`
	Model             string          `json:"model,omitempty"`
	Content           string          `json:"content,omitempty"`
	Truncated         bool            `json:"truncated,omitempty"`
	OriginalBytes     int64           `json:"original_bytes,omitempty"`
	Attachments       json.RawMessage `json:"attachments,omitempty"`
	Metadata          json.RawMessage `json:"metadata,omitempty"`
	Reason            string          `json:"reason,omitempty"`
	QueueEmpty        bool            `json:"queue_empty,omitempty"`
	// HistoryUnavailable 表示节点已无法读取原 Worker 账本，中心据此结束仍活动的 Turn。
	HistoryUnavailable bool `json:"history_unavailable,omitempty"`
}

type ThreadReportResult struct {
	Type              string `json:"type"`
	ThreadID          string `json:"thread_id"`
	EventID           string `json:"event_id"`
	WorkerSeq         int64  `json:"worker_seq"`
	OK                bool   `json:"ok"`
	Code              string `json:"code,omitempty"`
	ExpectedWorkerSeq int64  `json:"expected_worker_seq,omitempty"`
}
