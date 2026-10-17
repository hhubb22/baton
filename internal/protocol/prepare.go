package protocol

import "encoding/json"

const (
	// BodyPrepare 是发给节点的准备命令。Relay 不解释 body。
	BodyPrepare = "execution.prepare"
	// BodyPrepareResult 是节点在本地保存之后返回的准备结果。
	BodyPrepareResult = "execution.prepare_result"
)

// PrepareCommand 只携带绑定 Worker 和被动检查所需的字段，不包含任务说明。
type PrepareCommand struct {
	Type              string `json:"type"`
	TaskID            string `json:"task_id"`
	ExecutionID       string `json:"execution_id"`
	TaskVersion       int    `json:"task_version"`
	StorageGeneration string `json:"storage_generation,omitempty"`
	QueueExpiresAt    string `json:"queue_expires_at"`
	AgentType         string `json:"agent_type"`
	TargetSessionID   string `json:"target_session_id,omitempty"`
	WorkingDirectory  string `json:"working_directory,omitempty"`
}

// PrepareResult 是一次准备的业务结果。OK 为 false 时表示节点明确拒绝，不是传输失败。
type PrepareResult struct {
	Type              string `json:"type"`
	OK                bool   `json:"ok"`
	Code              string `json:"code,omitempty"`
	Message           string `json:"message,omitempty"`
	TaskID            string `json:"task_id,omitempty"`
	ExecutionID       string `json:"execution_id,omitempty"`
	SessionID         string `json:"session_id,omitempty"`
	StorageGeneration string `json:"storage_generation,omitempty"`
}

// MessageID 从信封里取出 message_id。解析失败时返回空字符串。
func MessageID(raw json.RawMessage) string {
	var env struct {
		MessageID string `json:"message_id"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return ""
	}
	return env.MessageID
}
