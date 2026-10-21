package pi

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"baton/internal/agent"
)

const threadInstructions = `You are running in a Baton Thread. The working directory is %q. To reference an attachment, include its path within a registered directory in your reply. To reference a Git commit, write commit <SHA>.`

type sendIntent struct {
	text      string
	userCount int
}

func (a *Adapter) Capabilities() agent.Capabilities {
	return agent.Capabilities{Steer: true, Resume: true}
}

func (a *Adapter) NativeSessionID() string { return a.config.SessionID }

// UserMessageCount reads persisted user messages, including steering messages.
func (a *Adapter) UserMessageCount() (int, error) {
	count := 0
	err := a.walkHistory(func(m message) {
		if m.Role == "user" {
			count++
		}
	})
	if err != nil {
		a.mu.Lock()
		fresh := a.freshHistory
		a.mu.Unlock()
		// Pi creates a new JSONL file lazily, when the first prompt starts.
		if fresh {
			root, openErr := os.OpenRoot(a.config.SessionDir)
			if openErr == nil {
				defer root.Close()
				rel, relErr := filepath.Rel(a.config.SessionDir, a.history.File)
				if relErr == nil {
					if _, statErr := root.Lstat(rel); errors.Is(statErr, os.ErrNotExist) {
						return 0, nil
					}
				}
			}
		}
		return 0, err
	}
	return count, nil
}

func (a *Adapter) RestoreIntent(id, text string, userCount int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.intents == nil {
		a.intents = make(map[string]sendIntent)
	}
	a.intents[id] = sendIntent{text: text, userCount: userCount}
}

func (a *Adapter) Sent(id string) (bool, error) {
	a.mu.Lock()
	intent, ok := a.intents[id]
	a.mu.Unlock()
	if !ok || intent.userCount < 0 {
		return false, errors.New("Pi send intent missing or invalid")
	}
	index, found := 0, false
	err := a.walkHistory(func(m message) {
		if m.Role != "user" {
			return
		}
		if index >= intent.userCount && textContent(m.Content) == intent.text {
			found = true
		}
		index++
	})
	if err != nil {
		return false, err
	}
	return found, nil
}

func (a *Adapter) Send(ctx context.Context, id, text string) error {
	return a.sendThreadInput(ctx, id, text, false)
}

func (a *Adapter) Steer(ctx context.Context, id, text string) error {
	return a.sendThreadInput(ctx, id, text, true)
}

func (a *Adapter) sendThreadInput(ctx context.Context, id, text string, steer bool) error {
	a.inputMu.Lock()
	defer a.inputMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if id == "" {
		return errors.New("Pi client message ID required")
	}
	a.mu.Lock()
	if a.closed || a.done == nil {
		a.mu.Unlock()
		return errors.New("Pi process not running")
	}
	select {
	case <-a.done:
		a.mu.Unlock()
		return errors.New("Pi process exited")
	default:
	}
	if !steer && a.active {
		a.mu.Unlock()
		return agent.ErrBusy
	}
	if steer && (!a.active || !a.threadStarted || a.aborting) {
		a.mu.Unlock()
		return errors.New("Pi has no running Thread turn to steer")
	}
	a.mu.Unlock()
	count, err := a.UserMessageCount()
	if err != nil {
		return err
	}
	a.RestoreIntent(id, text, count)
	a.mu.Lock()
	// Settlement can arrive while the history file is being read.
	if steer && (!a.active || a.aborting) {
		a.mu.Unlock()
		return errors.New("Pi Thread turn ended before steering")
	}
	if !steer {
		a.threadTurn, a.threadStarted, a.threadMessageID = true, false, id
		a.active, a.aborting, a.final, a.stopReason, a.waiting = true, false, "", "", false
		a.usedTools = false
		a.settled = make(chan struct{})
	}
	freshHistory := a.freshHistory
	a.freshHistory = false
	a.mu.Unlock()
	command := "prompt"
	if steer {
		command = "steer"
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	r, err := a.call(ctx, command, map[string]any{"message": text})
	if err == nil && !steer {
		var data struct {
			Disposition string `json:"disposition"`
		}
		if json.Unmarshal(r.Data, &data) != nil || data.Disposition != "started" {
			err = errors.New("Pi did not start the Thread prompt")
		}
	}
	if err != nil {
		a.mu.Lock()
		if r.Type == "response" && r.Command == command && !r.Success {
			if !steer && !a.threadStarted {
				a.active, a.threadTurn = false, false
				a.freshHistory = freshHistory
			}
		} else {
			a.events = append(a.events, agent.Event{Kind: agent.EventUncertain, ClientMessageID: id, Reason: err.Error()})
		}
		a.mu.Unlock()
	}
	return err
}

// Prompt acceptance is recorded in the reader before any subsequent replies.
func (a *Adapter) acceptThreadPromptLocked(r response) {
	if !a.threadTurn || !a.active || a.threadStarted || r.ID == "" || r.ID != a.threadPromptRPCID || r.Command != "prompt" || !r.Success {
		return
	}
	var data struct {
		Disposition string `json:"disposition"`
	}
	if json.Unmarshal(r.Data, &data) == nil && data.Disposition == "started" {
		a.threadStarted = true
		a.events = append(a.events, agent.Event{Kind: agent.EventTurnStarted, ClientMessageID: a.threadMessageID, NativeSessionID: a.NativeSessionID()})
	}
}

func (a *Adapter) endThreadTurnLocked(r response) {
	if !a.threadTurn {
		return
	}
	reason := agent.EndCompleted
	if a.aborting || r.Aborted || a.stopReason == "aborted" {
		reason = agent.EndStopped
	} else if a.stopReason == "error" {
		reason = agent.EndFailed
	}
	a.events = append(a.events, agent.Event{Kind: agent.EventTurnEnded, Reason: reason})
	a.threadTurn, a.threadStarted = false, false
}

func (a *Adapter) processExitedLocked(readErr error) {
	if a.closed {
		return
	}
	if a.active || readErr != nil {
		reason := "Pi process exited before settlement"
		if readErr != nil {
			reason = readErr.Error()
		}
		a.events = append(a.events, agent.Event{Kind: agent.EventUncertain, Reason: reason})
	}
	a.events = append(a.events, agent.Event{Kind: agent.EventExited, NativeSessionID: a.NativeSessionID()})
}

func (a *Adapter) DrainEvents() []agent.Event {
	a.mu.Lock()
	defer a.mu.Unlock()
	events := a.events
	a.events = nil
	return events
}
