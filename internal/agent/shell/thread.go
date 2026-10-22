package shell

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"baton/internal/agent"
)

var _ agent.Adapter = (*Adapter)(nil)

func (*Adapter) Capabilities() agent.Capabilities            { return agent.Capabilities{} }
func (*Adapter) Steer(context.Context, string, string) error { return agent.ErrUnsupported }

func (a *Adapter) Send(ctx context.Context, id, text, model string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.process != nil && !a.stopped {
		return agent.ErrBusy
	}
	if model != "" {
		return &agent.ModelSwitchError{Err: agent.ErrUnsupported}
	}
	if !a.started || a.closed || a.submitted || a.stopped {
		return errors.New("shell Thread 只能执行一轮")
	}
	if id == "" || text == "" {
		return errors.New("命令和消息 ID 不能为空")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	a.messageID, a.submitted = id, true
	return a.launchLocked(ctx, text)
}

func (a *Adapter) Drain() []agent.Event {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.maintainLocked()
	if a.diagnostic != nil {
		a.events = append(a.events, *a.diagnostic)
		a.diagnostic = nil
	}
	events := a.events
	a.events = nil
	return events
}

func (a *Adapter) Sent(id string) (bool, error) {
	if id == "" {
		return false, agent.ErrHistoryUnread
	}
	record, err := a.loadCompletion()
	if err != nil {
		return false, fmt.Errorf("%w: %v", agent.ErrHistoryUnread, err)
	}
	if record.SchemaVersion != 3 {
		return false, agent.ErrHistoryUnread
	}
	return record.MessageID == id, nil
}

func (a *Adapter) completionEventsLocked(record *completionRecord) {
	a.messageID = record.MessageID
	result := record.Result
	metadata, _ := json.Marshal(struct {
		ExitCode int    `json:"exit_code"`
		Encoding string `json:"encoding,omitempty"`
	}{result.ExitCode, result.Encoding})
	reason := agent.EndCompleted
	if record.CompletionKind == "stopped" {
		reason = agent.EndStopped
	}
	a.events = append(a.events,
		agent.Event{Kind: agent.EventReply, ClientMessageID: record.MessageID, NativeSessionID: record.SessionID, Content: result.Output, Truncated: result.Truncated, OriginalBytes: result.TotalBytes, Metadata: metadata},
		agent.Event{Kind: agent.EventTurnEnded, ClientMessageID: record.MessageID, NativeSessionID: record.SessionID, Reason: reason},
		agent.Event{Kind: agent.EventExited, ClientMessageID: record.MessageID, NativeSessionID: record.SessionID},
	)
}
