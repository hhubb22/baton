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
	Steer       bool `json:"steer"`
	Resume      bool `json:"resume"`
	SwitchModel bool `json:"switch_model"`
}

// ModelSwitchError 表示模型选择失败，消息确定尚未发出。
// Worker 可以撤回这条消息，并保存停止原因。
type ModelSwitchError struct {
	Err error
}

func (e *ModelSwitchError) Error() string { return "model selection failed: " + e.Err.Error() }
func (e *ModelSwitchError) Unwrap() error { return e.Err }

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

// Adapter defines the Thread/Turn native Agent contract (Baton TECH "Agent 适配").
type Adapter interface {
	Start(ctx context.Context) error                        // 新建或恢复原生会话
	Send(ctx context.Context, id, text, model string) error // 开启新 Turn；model 为空时沿用当前模型
	Steer(ctx context.Context, id, text string) error       // 加入当前 Turn；不支持时返回 ErrUnsupported
	Abort() (stopped, outcomeKnown bool, err error)         // 停止当前 Turn
	Drain() []Event                                         // 非阻塞取回 TurnStarted、Reply、TurnEnded、Exited、Uncertain
	Sent(id string) (bool, error)                           // 在原生历史里查找这条消息
	ReadHistory(ctx context.Context, cursor string) (HistoryPage, error)
	Capabilities() Capabilities // steer、resume、switch_model
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

type Config struct {
	DataDir    string
	Directory  string
	SessionDir string
	SessionID  string
	StatePath  string
	Home       string
	Model      string
	Binary     string
	Env        []string `json:"-"`
	Restore    bool
}

type HistoryPage struct {
	Data       json.RawMessage
	NextCursor string
}
