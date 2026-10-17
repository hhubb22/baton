package protocol

import "encoding/json"

const (
	// BodyPrepare 是发给节点的准备命令。Relay 不解释 body。
	BodyPrepare = "execution.prepare"
	// BodyPrepareResult 是节点在本地保存之后返回的准备结果。
	BodyPrepareResult = "execution.prepare_result"
	// BodyStartPermit 是节点为已准备的执行申请短时启动许可。
	BodyStartPermit = "execution.start_permit"
	// BodyStartPermitResult 是中心对启动许可申请的答复。许可正文只在 OK 时出现。
	BodyStartPermitResult = "execution.start_permit_result"
	// BodyStartReport 是节点在写入 start_intent 之前拒绝启动的回执。
	BodyStartReport = "execution.start_report"
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

// StartPermitRequest 只携带核对执行身份所需的字段，不包含任务说明。
type StartPermitRequest struct {
	Type              string `json:"type"`
	TaskID            string `json:"task_id"`
	ExecutionID       string `json:"execution_id"`
	SessionID         string `json:"session_id"`
	StorageGeneration string `json:"storage_generation"`
	Nonce             string `json:"nonce"`
}

// StartPermitResult 把签名后的许可交回节点。OK 为 false 时没有许可。
type StartPermitResult struct {
	Type        string `json:"type"`
	OK          bool   `json:"ok"`
	Code        string `json:"code,omitempty"`
	Message     string `json:"message,omitempty"`
	TaskID      string `json:"task_id,omitempty"`
	ExecutionID string `json:"execution_id,omitempty"`
	Permit      string `json:"permit,omitempty"`
}

// StartReport 表示节点确认还没有写入 start_intent。Started 在本阶段不会为 true。
type StartReport struct {
	Type        string `json:"type"`
	TaskID      string `json:"task_id"`
	ExecutionID string `json:"execution_id"`
	Started     bool   `json:"started"`
	Code        string `json:"code,omitempty"`
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
