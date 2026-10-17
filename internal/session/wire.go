package session

import (
	"encoding/json"
	"errors"
)

var (
	// ErrSessionOwned 表示另一个 Worker 已经持有这个 Session 的文件锁。
	ErrSessionOwned = errors.New("已有 Worker 接管该 Session")
	// ErrSessionBusy 表示这个 Session 已经绑定了另一份执行。
	ErrSessionBusy  = errors.New("Session 正在执行其他任务")
	errEndpointBusy = errors.New("Session Worker 已在监听")
)

type ipcMessage struct {
	Type              string      `json:"type"`
	Token             string      `json:"token,omitempty"`
	TaskID            string      `json:"task_id,omitempty"`
	ExecutionID       string      `json:"execution_id,omitempty"`
	AgentType         string      `json:"agent_type,omitempty"`
	Note              string      `json:"note,omitempty"`
	Permit            string      `json:"permit,omitempty"`
	PublicKey         string      `json:"public_key,omitempty"`
	StorageGeneration string      `json:"storage_generation,omitempty"`
	QueueExpiresAt    string      `json:"queue_expires_at,omitempty"`
	Nonce             string      `json:"nonce,omitempty"`
	Started           bool        `json:"started,omitempty"`
	Refused           bool        `json:"refused,omitempty"`
	StartIntent       bool        `json:"start_intent,omitempty"`
	OK                bool        `json:"ok"`
	Code              string      `json:"code,omitempty"`
	Message           string      `json:"message,omitempty"`
	PID               int         `json:"pid,omitempty"`
	SessionID         string      `json:"session_id,omitempty"`
	Payload           string      `json:"payload,omitempty"`
	EventID           string      `json:"event_id,omitempty"`
	ExecutorStarts    int64       `json:"executor_starts"`
	ExecutorInputs    int64       `json:"executor_inputs"`
	HookRuns          int64       `json:"hook_runs"`
	InputSubmitted    bool        `json:"input_submitted,omitempty"`
	ResultDelivered   bool        `json:"result_delivered,omitempty"`
	Uncertain         bool        `json:"uncertain,omitempty"`
	Attaches          int         `json:"attaches,omitempty"`
	Seq               int64       `json:"seq,omitempty"`
	Reports           []ipcReport `json:"reports,omitempty"`
}

type ipcReport struct {
	EventID string          `json:"event_id"`
	Kind    string          `json:"kind"`
	Body    json.RawMessage `json:"body"`
}

// Status 是 Worker 对一次状态查询的回答。准备阶段的执行器计数必须保持为 0。
type Status struct {
	PID             int
	SessionID       string
	ExecutorStarts  int64
	ExecutorInputs  int64
	HookRuns        int64
	InputSubmitted  bool
	ResultDelivered bool
	Uncertain       bool
	TaskID          string
	ExecutionID     string
	Attaches        int
	Seq             int64
	Nonce           string
	Started         bool
	Refused         bool
	StartIntent     bool
	Code            string
	Reports         []Report
}

// Report 是 Worker 尚未得到中心确认的一条执行事实。
type Report struct {
	EventID string
	Kind    string
	Body    json.RawMessage
}
