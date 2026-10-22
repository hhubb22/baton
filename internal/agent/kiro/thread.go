package kiro

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"baton/internal/agent"

	"github.com/sourcegraph/jsonrpc2"
)

var _ agent.Adapter = (*Adapter)(nil)
var _ agent.IntentRestorer = (*Adapter)(nil)
var _ agent.SessionIDProvider = (*Adapter)(nil)

type sendIntent struct {
	text      string
	userCount int
}

func (*Adapter) Capabilities() agent.Capabilities            { return agent.Capabilities{Resume: true} }
func (*Adapter) Steer(context.Context, string, string) error { return agent.ErrUnsupported }
func (a *Adapter) NativeSessionID() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state.NativeID
}

func (a *Adapter) Send(ctx context.Context, id, text, model string) error {
	a.sendMu.Lock()
	defer a.sendMu.Unlock()
	a.mu.Lock()
	if a.active {
		a.mu.Unlock()
		return agent.ErrBusy
	}
	if model != "" && model != a.config.Model {
		a.mu.Unlock()
		return &agent.ModelSwitchError{Err: agent.ErrUnsupported}
	}
	if a.closed || a.state.NativeID == "" {
		a.mu.Unlock()
		return agent.ErrHistoryMissing
	}
	if id == "" || slices.Contains(a.state.Operations, id) {
		a.mu.Unlock()
		return ErrUncertain
	}
	a.mu.Unlock()
	entries, err := a.nativeHistory(ctx)
	if err != nil {
		return err
	}
	users, err := historyUsers(entries)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return agent.ErrHistoryMissing
	}
	a.restoreIntentLocked(id, text, len(users))
	a.state.Pending = true
	a.state.Operations = append(a.state.Operations, id)
	if err := a.saveLocked(); err != nil {
		a.mu.Unlock()
		return err
	}
	a.active, a.stopped, a.aborting = true, false, false
	a.usedTools = false
	a.threadMessageID = id
	a.threadReply = replyBuffer{}
	a.settled = make(chan struct{})
	settled, native := a.settled, a.state.NativeID
	a.threadEventLocked(agent.Event{Kind: agent.EventTurnStarted})
	a.mu.Unlock()
	waiter, err := a.conn.DispatchCall(ctx, "session/prompt", map[string]any{"sessionId": native, "prompt": []map[string]string{{"type": "text", "text": text}}})
	if err != nil {
		a.mu.Lock()
		a.active = false
		a.threadEventLocked(agent.Event{Kind: agent.EventUncertain})
		close(settled)
		a.mu.Unlock()
		return ErrUncertain
	}
	go func() {
		defer close(settled)
		var result struct {
			StopReason string `json:"stopReason"`
		}
		err := waiter.Wait(context.Background(), &result)
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.closed {
			return
		}
		a.active = false
		a.flushReplyLocked()
		var rpcErr *jsonrpc2.Error
		if err != nil && !errors.As(err, &rpcErr) {
			a.threadEventLocked(agent.Event{Kind: agent.EventUncertain})
			return
		}
		reason := agent.EndFailed
		if err == nil {
			switch result.StopReason {
			case "end_turn":
				reason = agent.EndCompleted
			case "cancelled":
				reason = agent.EndStopped
			}
		}
		if a.aborting {
			reason = agent.EndStopped
		}
		a.state.Pending, a.stopped = false, true
		if err := a.saveLocked(); err != nil {
			a.threadEventLocked(agent.Event{Kind: agent.EventUncertain})
			return
		}
		a.threadEventLocked(agent.Event{Kind: agent.EventTurnEnded, Reason: reason})
	}()
	return nil
}

func (a *Adapter) threadEventLocked(event agent.Event) {
	event.ClientMessageID, event.NativeSessionID = a.threadMessageID, a.state.NativeID
	if len(a.threadEvents) >= 128 {
		a.threadEvents = []agent.Event{{Kind: agent.EventUncertain, NativeSessionID: a.state.NativeID, ClientMessageID: a.threadMessageID}}
	}
	a.threadEvents = append(a.threadEvents, event)
}
func (a *Adapter) flushReplyLocked() {
	if a.threadReply.total == 0 {
		return
	}
	content := a.threadReply.text()
	a.threadEventLocked(agent.Event{Kind: agent.EventReply, Content: content, OriginalBytes: a.threadReply.total, Truncated: a.threadReply.total > 32*1024})
	a.threadReply = replyBuffer{}
}
func (a *Adapter) Drain() []agent.Event {
	a.mu.Lock()
	defer a.mu.Unlock()
	events := a.threadEvents
	a.threadEvents = nil
	return events
}
func (a *Adapter) restoreIntentLocked(id, text string, count int) {
	if a.intents == nil {
		a.intents = make(map[string]sendIntent)
	}
	a.intents[id] = sendIntent{text: text, userCount: count}
}
func (a *Adapter) RestoreIntent(id, text string, userCount int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.restoreIntentLocked(id, text, userCount)
}
func (a *Adapter) UserMessageCount() (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	entries, err := a.nativeHistory(ctx)
	if err != nil {
		return 0, err
	}
	users, err := historyUsers(entries)
	return len(users), err
}
func (a *Adapter) Sent(id string) (bool, error) {
	a.mu.Lock()
	intent, ok := a.intents[id]
	a.mu.Unlock()
	if !ok || intent.userCount < 0 {
		return false, agent.ErrHistoryUnread
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	entries, err := a.nativeHistory(ctx)
	if err != nil {
		return false, err
	}
	users, err := historyUsers(entries)
	if err != nil {
		return false, err
	}
	if intent.userCount > len(users) {
		return false, agent.ErrHistoryChanged
	}
	for _, text := range users[intent.userCount:] {
		if text == intent.text {
			return true, nil
		}
	}
	return false, nil
}

// historyUsers joins chunks belonging to one persisted user message. Kiro's
// replay ID distinguishes consecutive messages with the same role.
func historyUsers(entries []json.RawMessage) ([]string, error) {
	var users []string
	previousUser, previousID := false, ""
	for _, raw := range entries {
		var entry struct {
			Update struct {
				Kind    string                      `json:"sessionUpdate"`
				Content struct{ Type, Text string } `json:"content"`
				Meta    struct {
					Kiro struct {
						ReplayID  string `json:"replayId"`
						MessageID string `json:"messageId"`
					} `json:"kiro"`
				} `json:"_meta"`
			} `json:"update"`
		}
		// Tool content can be an array; inspect its kind before decoding text.
		var header struct {
			Update struct {
				Kind string `json:"sessionUpdate"`
			} `json:"update"`
		}
		if json.Unmarshal(raw, &header) != nil {
			return nil, agent.ErrHistoryUnread
		}
		if header.Update.Kind != "user_message_chunk" {
			if header.Update.Kind == "agent_message_chunk" || header.Update.Kind == "tool_call" {
				previousUser = false
			}
			continue
		}
		if json.Unmarshal(raw, &entry) != nil || entry.Update.Content.Type != "text" {
			return nil, agent.ErrHistoryUnread
		}
		id := entry.Update.Meta.Kiro.ReplayID
		if id == "" {
			id = entry.Update.Meta.Kiro.MessageID
		}
		if previousUser && id == previousID {
			users[len(users)-1] += entry.Update.Content.Text
		} else {
			users = append(users, entry.Update.Content.Text)
		}
		previousUser, previousID = true, id
	}
	return users, nil
}

type replyBuffer struct {
	head, tail string
	total      int64
}

func (b *replyBuffer) append(text string) {
	b.total += int64(len(text))
	const half = 16 * 1024
	if len(b.head) < half {
		n := min(half-len(b.head), len(text))
		b.head += text[:n]
		text = text[n:]
	}
	if len(text) >= half {
		b.tail = text[len(text)-half:]
	} else {
		b.tail += text
		if len(b.tail) > half {
			b.tail = b.tail[len(b.tail)-half:]
		}
	}
}
func (b *replyBuffer) text() string {
	if b.total <= 32*1024 {
		return b.head + b.tail
	}
	head, tail := b.head, b.tail
	for !utf8.ValidString(head) && len(head) > 0 {
		head = head[:len(head)-1]
	}
	for len(tail) > 0 && !utf8.RuneStart(tail[0]) {
		tail = tail[1:]
	}
	return strings.ToValidUTF8(head+tail, "�")
}
