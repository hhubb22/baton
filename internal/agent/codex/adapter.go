package codex

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"

	"baton/internal/agent"
	"baton/internal/task"
)

func (a *Adapter) Start(ctx context.Context) error {
	if a.config.Restore {
		return a.Attach(ctx)
	}
	if a.config.SessionDir != "" {
		if info, err := os.Lstat(a.config.SessionDir); err == nil {
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return ErrHistoryMissing
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		if err := os.MkdirAll(a.config.SessionDir, 0o700); err != nil {
			return err
		}
	}
	return a.CreateSession(ctx)
}

func (a *Adapter) SubmitInput(ctx context.Context, payload string) (agent.Output, error) {
	var input struct {
		Description string `json:"description"`
		Generation  int    `json:"generation"`
	}
	if len(payload) > task.ExecutorInputLimit || json.Unmarshal([]byte(payload), &input) != nil || input.Description == "" || input.Generation != 1 || a.config.ExecutionID == "" {
		return agent.Output{}, errors.New("invalid Codex task input")
	}
	return agent.Output{}, a.StartTask(ctx, a.config.ExecutionID+":1", payload)
}

func (a *Adapter) DeliverResult(ctx context.Context, deliveryID, payload string) (agent.Output, error) {
	var envelope struct {
		DeliveryID string `json:"delivery_id"`
	}
	if deliveryID == "" || json.Unmarshal([]byte(payload), &envelope) != nil || envelope.DeliveryID != deliveryID || len(payload) > task.ExecutorInputLimit {
		return agent.Output{}, errors.New("Codex delivery identity mismatch")
	}
	if found, err := a.HistoryContains(deliveryID, false); err != nil || found {
		return agent.Output{}, err
	}
	a.mu.Lock()
	active := a.active
	a.mu.Unlock()
	if active {
		return agent.Output{}, a.SendInput(ctx, deliveryID, payload)
	}
	return agent.Output{}, a.StartTask(ctx, deliveryID, payload)
}

func (a *Adapter) Drain() []agent.Output {
	var outputs []agent.Output
	for {
		select {
		case e := <-a.events:
			out := agent.Output{Raw: e.Raw, Final: e.Final, Exited: e.Settled || e.Stopped, Uncertain: e.Uncertain}
			var waiting struct {
				Waiting bool `json:"baton_waiting_for_children"`
			}
			if e.Settled && !e.Uncertain && json.Unmarshal([]byte(e.Final), &waiting) == nil && waiting.Waiting {
				out.Final, out.Exited, out.WaitingForChildren = "", false, true
			}
			outputs = append(outputs, out)
		default:
			return outputs
		}
	}
}

func (a *Adapter) Abort() (bool, bool, error) {
	if stopped, known := a.StopStatus(); stopped {
		return stopped, known, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return a.Interrupt(ctx)
}

func (a *Adapter) StopStatus() (bool, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.stopped, false
}

func (a *Adapter) HistoryContains(deliveryID string, queried bool) (bool, error) {
	if deliveryID == "" {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cursor, seen := "", map[string]bool{}
	for {
		page, err := a.ReadHistory(ctx, cursor)
		if err != nil {
			return false, err
		}
		var items []struct {
			Item struct {
				Type, ClientID, AggregatedOutput string
				ExitCode                         *int
				Content                          []struct{ Text string }
			} `json:"item"`
		}
		if json.Unmarshal(page.Data, &items) != nil {
			return false, ErrIncompatible
		}
		for _, entry := range items {
			item := entry.Item
			if !queried && item.Type == "userMessage" && item.ClientID == deliveryID {
				return true, nil
			}
			var texts []string
			if !queried && item.Type == "userMessage" {
				for _, content := range item.Content {
					texts = append(texts, content.Text)
				}
			} else if queried && item.Type == "commandExecution" && item.ExitCode != nil && *item.ExitCode == 0 {
				texts = append(texts, item.AggregatedOutput)
			}
			for _, text := range texts {
				for _, line := range strings.Split(text, "\n") {
					var envelope struct {
						DeliveryID string `json:"delivery_id"`
					}
					if json.Unmarshal([]byte(line), &envelope) == nil && envelope.DeliveryID == deliveryID {
						return true, nil
					}
				}
			}
		}
		if page.NextCursor == "" {
			return false, nil
		}
		if seen[page.NextCursor] {
			return false, ErrIncompatible
		}
		cursor, seen[page.NextCursor] = page.NextCursor, true
	}
}
