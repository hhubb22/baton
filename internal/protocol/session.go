package protocol

const (
	BodySessionRequest = "session.request"
	BodySessionResult  = "session.result"
	SessionOutputBytes = 16 * 1024
	SessionBufferBytes = 256 * 1024
)

// SessionRequest 查询 Thread 的本地历史或实时输出，不进入中心 outbox。
type SessionRequest struct {
	Type        string `json:"type"`
	OperationID string `json:"operation_id"`
	SessionID   string `json:"session_id"`
	Action      string `json:"action"`
	Cursor      string `json:"cursor,omitempty"`
	Limit       int    `json:"limit,omitempty"`
}

// SessionResult 只包含本次受限查询的结果，完整历史保留在节点。
type SessionResult struct {
	History     *SessionHistoryPage `json:"history,omitempty"`
	Type        string              `json:"type"`
	OperationID string              `json:"operation_id"`
	SessionID   string              `json:"session_id"`
	OK          bool                `json:"ok"`
	Code        string              `json:"code,omitempty"`
	State       string              `json:"state,omitempty"`
	Text        string              `json:"text,omitempty"`
	Cursor      string              `json:"cursor,omitempty"`
	Gap         bool                `json:"gap"`
}
