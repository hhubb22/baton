package shell

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"baton/internal/agent"
	"baton/internal/task"
)

var _ agent.ThreadAdapter = (*Adapter)(nil)

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
	a.threadMode, a.messageID, a.submitted = true, id, true
	return a.launchLocked(ctx, text)
}

func (a *Adapter) DrainEvents() []agent.Event {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.maintainLocked()
	events := a.events
	a.events = nil
	return events
}

func (a *Adapter) Sent(id string) (bool, error) {
	if id == "" {
		return false, agent.ErrHistoryUnread
	}
	record, err := a.loadCompletion(true)
	if err != nil {
		return false, fmt.Errorf("%w: %v", agent.ErrHistoryUnread, err)
	}
	if record.SchemaVersion != 2 {
		return false, agent.ErrHistoryUnread
	}
	return record.MessageID == id, nil
}

func (a *Adapter) completionEventsLocked(record *completionRecord) {
	if record.SchemaVersion != 2 {
		return
	}
	candidate, err := task.ParseCandidate(string(record.Result))
	if err != nil || candidate.CommandResult == nil {
		a.events = append(a.events, agent.Event{Kind: agent.EventUncertain})
		return
	}
	a.threadMode, a.messageID = true, record.MessageID
	result := candidate.CommandResult
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
