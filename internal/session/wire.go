package session

import "errors"

var (
	// ErrSessionOwned 表示另一个 Worker 已经持有这个 Session 的文件锁。
	ErrSessionOwned = errors.New("已有 Worker 接管该 Session")
	// ErrSessionBusy 表示这个 Session 已经绑定了另一份执行。
	ErrSessionBusy  = errors.New("Session 正在执行其他任务")
	errEndpointBusy = errors.New("Session Worker 已在监听")
)

type ipcMessage struct {
	Type           string `json:"type"`
	Token          string `json:"token,omitempty"`
	TaskID         string `json:"task_id,omitempty"`
	ExecutionID    string `json:"execution_id,omitempty"`
	AgentType      string `json:"agent_type,omitempty"`
	Note           string `json:"note,omitempty"`
	OK             bool   `json:"ok"`
	Code           string `json:"code,omitempty"`
	Message        string `json:"message,omitempty"`
	PID            int    `json:"pid,omitempty"`
	SessionID      string `json:"session_id,omitempty"`
	ExecutorStarts int64  `json:"executor_starts"`
	HookRuns       int64  `json:"hook_runs"`
	Attaches       int    `json:"attaches,omitempty"`
	Seq            int64  `json:"seq,omitempty"`
}

// Status 是 Worker 对一次状态查询的回答。准备阶段的执行器计数必须保持为 0。
type Status struct {
	PID            int
	SessionID      string
	ExecutorStarts int64
	HookRuns       int64
	Attaches       int
	Seq            int64
}
