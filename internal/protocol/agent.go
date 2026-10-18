package protocol

import (
	"encoding/json"

	"baton/internal/task"
)

const (
	BodyAgentRequest = "agent.request"
	BodyAgentResult  = "agent.result"
)

// AgentRequest 的来源只由 batond 从本地凭据绑定中填入。员工和节点来自 Relay。
type AgentRequest struct {
	Type              string      `json:"type"`
	Operation         string      `json:"operation"`
	SourceTaskID      string      `json:"source_task_id"`
	SourceSessionID   string      `json:"source_session_id"`
	SourceExecutionID string      `json:"source_execution_id"`
	TaskID            string      `json:"task_id,omitempty"`
	Input             *task.Input `json:"input,omitempty"`
}

type AgentResult struct {
	Type    string          `json:"type"`
	OK      bool            `json:"ok"`
	Code    string          `json:"code,omitempty"`
	Message string          `json:"message,omitempty"`
	TaskID  string          `json:"task_id,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}
