// Package agent defines the process boundary shared by native Agent adapters.
package agent

import (
	"context"
	"encoding/json"
	"errors"
)

var (
	ErrHistoryMissing = errors.New("native Agent history missing or mismatched")
	ErrBusy           = errors.New("native Agent turn already active")
	ErrUnsupported    = errors.New("native Agent operation unsupported")
)

type Capabilities struct {
	Steer  bool `json:"steer"`
	Resume bool `json:"resume"`
}

const (
	EventTurnStarted = "turn.started"
	EventReply       = "reply"
	EventTurnEnded   = "turn.ended"
	EventExited      = "exited"
	EventUncertain   = "uncertain"
)

const (
	EndCompleted   = "completed"
	EndStopped     = "stopped"
	EndTimeout     = "timeout"
	EndAgentExited = "agent_exited"
	EndFailed      = "failed"
)

type Event struct {
	Kind            string          `json:"kind"`
	ClientMessageID string          `json:"client_message_id,omitempty"`
	NativeSessionID string          `json:"native_session_id,omitempty"`
	Content         string          `json:"content,omitempty"`
	Truncated       bool            `json:"truncated,omitempty"`
	OriginalBytes   int64           `json:"original_bytes,omitempty"`
	Metadata        json.RawMessage `json:"metadata,omitempty"`
	Reason          string          `json:"reason,omitempty"`
	Raw             json.RawMessage `json:"raw,omitempty"`
}

// ThreadAdapter defines the Thread/Turn native Agent contract (Baton TECH "Agent 适配").
type ThreadAdapter interface {
	Start(ctx context.Context) error                  // 新建或恢复原生会话
	Send(ctx context.Context, id, text string) error  // 开启新 Turn；Agent 忙时返回 ErrBusy
	Steer(ctx context.Context, id, text string) error // 加入当前 Turn；不支持时返回 ErrUnsupported
	Abort() (stopped, outcomeKnown bool, err error)   // 停止当前 Turn
	DrainEvents() []Event                             // 非阻塞取回 TurnStarted、Reply、TurnEnded、Exited、Uncertain
	Sent(id string) (bool, error)                     // 在原生历史里查找这条消息
	ReadHistory(ctx context.Context, cursor string) (HistoryPage, error)
	Capabilities() Capabilities // steer、resume
	Close() error
}

// IntentRestorer allows Session Worker to restore pre-send native user message
// counts before calling Sent(id) after a Worker restart (used by Pi and Kiro).
type IntentRestorer interface {
	UserMessageCount() (int, error)
	RestoreIntent(id, text string, userCount int)
}

// SessionIDProvider reports the native session identifier once started.
type SessionIDProvider interface {
	NativeSessionID() string
}

type Output struct {
	WaitingForChildren bool
	Progress           []string
	Final              string
	Exited             bool // The Agent has settled, not merely exited its OS process.
	Uncertain          bool
	Raw                json.RawMessage // Node-local native event; never an ExecutionReport.
}

type Config struct {
	DataDir     string
	Directory   string
	SessionDir  string
	SessionID   string
	ExecutionID string
	StatePath   string
	Home        string
	Model       string
	Binary      string
	Env         []string `json:"-"`
	Restore     bool
}

// Adapter never retries task input. Drain is nonblocking; control responses are
// not completion evidence. HistoryContains must inspect persisted native history.
// ReadHistory returns bounded, node-local pages, never Relay report payloads.
type Adapter interface {
	Start(context.Context) error
	SubmitInput(context.Context, string) (Output, error)
	DeliverResult(context.Context, string, string) (Output, error)
	HistoryContains(deliveryID string, queried bool) (bool, error)
	ReadHistory(context.Context, string) (HistoryPage, error)
	Drain() []Output
	Abort() (stopped, outcomeKnown bool, err error)
	Close() error
}

type HistoryPage struct {
	Data       json.RawMessage
	NextCursor string
}

// StopObserver retains stop evidence after Abort returns, including on timeout.
// Process exit alone is not settlement; observation must not retry task input.
type StopObserver interface {
	StopStatus() (stopped, outcomeKnown bool)
}
