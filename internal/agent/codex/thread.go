package codex

import (
	"context"
	"encoding/json"
	"fmt"

	"baton/internal/agent"
)

func threadInstructions(directory string) string {
	return fmt.Sprintf("You are working in a Baton Thread. Working directory: %s. In replies, reference files by their paths within registered directories, and commits as commit <SHA>.", directory)
}

func (a *Adapter) Capabilities() agent.Capabilities {
	return agent.Capabilities{Steer: true, Resume: true}
}

func (a *Adapter) NativeSessionID() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state.ThreadID
}

func (a *Adapter) Send(ctx context.Context, id, text string) error {
	return a.startTurn(ctx, id, text, true)
}

func (a *Adapter) Steer(ctx context.Context, id, text string) error {
	return a.SendInput(ctx, id, text)
}

func (a *Adapter) DrainEvents() []agent.Event {
	a.threadEventsMu.Lock()
	defer a.threadEventsMu.Unlock()
	events := a.threadEvents
	a.threadEvents = nil
	return events
}

// emitThread keeps native protocol handling independent of the Worker's polling rate.
// A full queue retains its prefix and reports uncertainty before closing the transport.
func (a *Adapter) emitThread(event agent.Event) {
	a.threadEventsMu.Lock()
	defer a.threadEventsMu.Unlock()
	if a.threadEventsFailed {
		return
	}
	if len(a.threadEvents) >= 127 {
		a.threadEvents = append(a.threadEvents, agent.Event{Kind: agent.EventUncertain, Reason: "Codex Thread event queue overflow"})
		a.threadEventsFailed = true
		go a.Close()
		return
	}
	a.threadEvents = append(a.threadEvents, event)
}

type threadItem struct {
	ID, Type, Text, Phase string
	ClientID              string `json:"clientId"`
	ClientUserMessageID   string `json:"clientUserMessageId"`
}

func (a *Adapter) threadStartedLocked(raw json.RawMessage) {
	if a.threadStarted {
		return
	}
	a.threadStarted = true
	a.emitThread(agent.Event{Kind: agent.EventTurnStarted, ClientMessageID: a.state.OperationID, NativeSessionID: a.state.ThreadID, Raw: raw})
}

func (a *Adapter) threadReplyLocked(item threadItem, raw json.RawMessage) {
	if item.Type != "agentMessage" || item.Phase == "commentary" {
		return
	}
	if item.ID != "" {
		if a.replyItems[item.ID] {
			return
		}
		if a.replyItems == nil {
			a.replyItems = make(map[string]bool)
		}
		a.replyItems[item.ID] = true
	}
	a.threadStartedLocked(nil)
	a.emitThread(agent.Event{Kind: agent.EventReply, Content: item.Text, NativeSessionID: a.state.ThreadID, Raw: raw})
}

// threadNotificationLocked maps native Turn evidence without interpreting reply content.
func (a *Adapter) threadNotificationLocked(method string, raw json.RawMessage) {
	var p struct {
		ThreadID string     `json:"threadId"`
		TurnID   string     `json:"turnId"`
		Turn     turn       `json:"turn"`
		Item     threadItem `json:"item"`
	}
	if json.Unmarshal(raw, &p) != nil || p.ThreadID != a.state.ThreadID || a.threadEnded {
		return
	}
	switch method {
	case "turn/started":
		if a.active && p.Turn.ID == a.state.TurnID && p.Turn.Status == "inProgress" {
			a.turnStarted = true
			a.threadStartedLocked(raw)
			a.retryInterruptLocked()
		}
	case "item/completed":
		if p.TurnID != a.state.TurnID || !a.active {
			return
		}
		a.threadReplyLocked(p.Item, raw)
	case "turn/completed":
		if p.Turn.ID != a.state.TurnID {
			return
		}
		var reason string
		switch p.Turn.Status {
		case "completed":
			reason = agent.EndCompleted
		case "interrupted":
			reason = agent.EndStopped
		case "failed":
			reason = agent.EndFailed
		default:
			a.emitThread(agent.Event{Kind: agent.EventUncertain, NativeSessionID: a.state.ThreadID, Raw: raw})
			return
		}
		a.threadStartedLocked(nil)
		// Embedded items cover immediately completed starts and resumed Turns.
		for _, rawItem := range p.Turn.Items {
			var item threadItem
			if json.Unmarshal(rawItem, &item) != nil {
				a.emitThread(agent.Event{Kind: agent.EventUncertain, Raw: rawItem})
				continue
			}
			a.threadReplyLocked(item, rawItem)
		}
		a.active, a.stopped, a.interruptPending = false, true, false
		a.state.Pending = false
		a.threadEnded = true
		if err := a.saveLocked(); err != nil || a.state.SteerID != "" {
			a.emitThread(agent.Event{Kind: agent.EventUncertain, NativeSessionID: a.state.ThreadID, Raw: raw})
		}
		a.emitThread(agent.Event{Kind: agent.EventTurnEnded, Reason: reason, NativeSessionID: a.state.ThreadID, Raw: raw})
	}
}
