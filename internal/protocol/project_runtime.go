package protocol

import "encoding/json"

const (
	BodyProjectRuntimeRequest = "project_runtime.request"
	BodyProjectRuntimeResult  = "project_runtime.result"
	BodyProjectRunStart       = "project_run_start"
	BodyProjectRunStop        = "project_run_stop"
	BodyProjectRunWake        = "project_run_wake"
	MaxProjectRuntimeBytes    = 192 << 10
)

type ProjectRunCommand struct {
	Type           string `json:"type"`
	RunID          string `json:"run_id"`
	LeaseEpoch     int64  `json:"lease_epoch"`
	Provider       string `json:"provider,omitempty"`
	Model          string `json:"model,omitempty"`
	ProjectID      string `json:"project_id,omitempty"`
	ConversationID string `json:"conversation_id,omitempty"`
}

// ProjectRuntimeRequest 的运行身份由 batond 根据私有 IPC 绑定填写。
type ProjectRuntimeRequest struct {
	Type          string          `json:"type"`
	RunID         string          `json:"run_id"`
	LeaseEpoch    int64           `json:"lease_epoch"`
	Operation     string          `json:"operation"`
	AfterSeq      int64           `json:"after_seq,omitempty"`
	MaxBytes      int             `json:"max_bytes,omitempty"`
	ClientEventID string          `json:"client_event_id,omitempty"`
	LastSeq       int64           `json:"last_seq,omitempty"`
	Payload       json.RawMessage `json:"payload,omitempty"`
	ToolCallID    string          `json:"tool_call_id,omitempty"`
	ToolName      string          `json:"tool_name,omitempty"`
	Arguments     json.RawMessage `json:"arguments,omitempty"`
	Reason        string          `json:"reason,omitempty"`
}

type ProjectRuntimeResult struct {
	Type string          `json:"type"`
	OK   bool            `json:"ok"`
	Code string          `json:"code,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}
