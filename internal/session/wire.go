package session

import (
	"encoding/json"
	"errors"
	"time"

	"baton/internal/protocol"
)

var (
	// ErrSessionOwned 表示另一个 Worker 已经持有这个 Session 的文件锁。
	ErrSessionOwned = errors.New("已有 Worker 接管该 Session")
	// ErrSessionBusy 表示这个 Session 已经绑定了另一份执行。
	ErrSessionBusy  = errors.New("Session 正在执行其他任务")
	errEndpointBusy = errors.New("Session Worker 已在监听")
)

// ThreadCommandError 表示 Worker 已收到命令并明确拒绝，Host 不因此重启进程。
type ThreadCommandError struct{ Message string }

func (e *ThreadCommandError) Error() string { return e.Message }

type ipcMessage struct {
	ClientMessageID   string                   `json:"client_message_id,omitempty"`
	Mode              string                   `json:"mode,omitempty"`
	AfterWorkerSeq    int64                    `json:"after_worker_seq,omitempty"`
	WorkerSeq         int64                    `json:"worker_seq,omitempty"`
	ThreadReports     []protocol.ThreadReport  `json:"thread_reports,omitempty"`
	SessionRequest    *protocol.SessionRequest `json:"session_request,omitempty"`
	SessionResult     *protocol.SessionResult  `json:"session_result,omitempty"`
	History           json.RawMessage          `json:"history,omitempty"`
	HistoryCursor     string                   `json:"history_cursor,omitempty"`
	ChildDelivery     *protocol.ChildDelivery  `json:"child_delivery,omitempty"`
	ChildReceipts     []protocol.ChildReceipt  `json:"child_receipts,omitempty"`
	Queried           bool                     `json:"queried,omitempty"`
	StopReason        string                   `json:"stop_reason,omitempty"`
	Cancelled         bool                     `json:"cancelled,omitempty"`
	InputDueAt        time.Time                `json:"input_due_at,omitempty"`
	Type              string                   `json:"type"`
	Token             string                   `json:"token,omitempty"`
	TaskID            string                   `json:"task_id,omitempty"`
	ExecutionID       string                   `json:"execution_id,omitempty"`
	AgentType         string                   `json:"agent_type,omitempty"`
	Note              string                   `json:"note,omitempty"`
	Permit            string                   `json:"permit,omitempty"`
	PublicKey         string                   `json:"public_key,omitempty"`
	StorageGeneration string                   `json:"storage_generation,omitempty"`
	QueueExpiresAt    string                   `json:"queue_expires_at,omitempty"`
	Nonce             string                   `json:"nonce,omitempty"`
	Started           bool                     `json:"started,omitempty"`
	Refused           bool                     `json:"refused,omitempty"`
	StartIntent       bool                     `json:"start_intent,omitempty"`
	OK                bool                     `json:"ok"`
	Code              string                   `json:"code,omitempty"`
	Message           string                   `json:"message,omitempty"`
	PID               int                      `json:"pid,omitempty"`
	SessionID         string                   `json:"session_id,omitempty"`
	Payload           string                   `json:"payload,omitempty"`
	EventID           string                   `json:"event_id,omitempty"`
	ExecutorStarts    int64                    `json:"executor_starts"`
	ExecutorInputs    int64                    `json:"executor_inputs"`
	HookRuns          int64                    `json:"hook_runs"`
	InputSubmitted    bool                     `json:"input_submitted,omitempty"`
	ResultDelivered   bool                     `json:"result_delivered,omitempty"`
	Uncertain         bool                     `json:"uncertain,omitempty"`
	Attaches          int                      `json:"attaches,omitempty"`
	Seq               int64                    `json:"seq,omitempty"`
	Reports           []ipcReport              `json:"reports,omitempty"`
}

type ipcReport struct {
	EventID string          `json:"event_id"`
	Kind    string          `json:"kind"`
	Body    json.RawMessage `json:"body"`
}

// Status 是 Worker 对一次状态查询的回答。准备阶段的执行器计数必须保持为 0。
type Status struct {
	ThreadReports   []protocol.ThreadReport
	SessionResult   *protocol.SessionResult
	History         json.RawMessage
	HistoryCursor   string
	ChildReceipts   []protocol.ChildReceipt
	Cancelled       bool
	InputDueAt      time.Time
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
