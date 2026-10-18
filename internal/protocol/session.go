package protocol

const (
	BodySessionRequest = "session.request"
	BodySessionResult  = "session.result"
	SessionOutputBytes = 16 * 1024
	SessionBufferBytes = 256 * 1024
)

// SessionRequest 是临时查询或有稳定操作标识的输入，不进入中心 outbox。
type SessionRequest struct {
	Type        string `json:"type"`
	OperationID string `json:"operation_id"`
	SessionID   string `json:"session_id"`
	Action      string `json:"action"`
	Cursor      string `json:"cursor,omitempty"`
	Text        string `json:"text,omitempty"`
}

// SessionResult 只包含本次受限输出和操作回执，完整历史保留在节点。
type SessionResult struct {
	ExecutionID    string `json:"execution_id,omitempty"`
	Type           string `json:"type"`
	OperationID    string `json:"operation_id"`
	SessionID      string `json:"session_id"`
	OK             bool   `json:"ok"`
	Code           string `json:"code,omitempty"`
	State          string `json:"state,omitempty"`
	InputSupported bool   `json:"input_supported"`
	Text           string `json:"text,omitempty"`
	Cursor         string `json:"cursor,omitempty"`
	Gap            bool   `json:"gap"`
}
