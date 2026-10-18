package codex

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
)

func drainTerminal(t *testing.T, a agent.Adapter) agent.Output {
	t.Helper()
	deadline := time.After(5 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline:
			t.Fatal("no unified terminal output")
			return agent.Output{}
		case <-tick.C:
			for _, out := range a.Drain() {
				if out.Exited || out.Uncertain || out.WaitingForChildren {
					return out
				}
			}
		}
	}
}

func TestUnifiedAdapterCompleteAndRestore(t *testing.T) {
	c := fixtureConfig(t, "complete")
	c.ExecutionID = "execution-fixture"
	ctx := context.Background()
	a := New(c)
	defer a.Close()
	var adapter agent.Adapter = a
	if err := adapter.Start(ctx); err != nil {
		t.Fatal(err)
	}
	const input = `{"description":"task","generation":1}`
	if _, err := adapter.SubmitInput(ctx, input); err != nil {
		t.Fatal(err)
	}
	if out := drainTerminal(t, adapter); !out.Exited || out.Uncertain || out.Final == "" || !json.Valid(out.Raw) {
		t.Fatalf("completion: %+v", out)
	}
	if _, err := adapter.SubmitInput(ctx, input); !errors.Is(err, ErrUncertain) {
		t.Fatalf("replayed operation: %v", err)
	}
	before := a.Snapshot()
	_ = adapter.Close()
	c.Restore = true
	b := New(c)
	defer b.Close()
	adapter = b
	if err := adapter.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if out := drainTerminal(t, adapter); !out.Exited || out.Uncertain {
		t.Fatalf("restore: %+v", out)
	}
	if after := b.Snapshot(); after.ThreadID != before.ThreadID || after.TurnID != before.TurnID {
		t.Fatal("restore changed native identity")
	}
	if page, err := adapter.ReadHistory(ctx, ""); err != nil || !json.Valid(page.Data) {
		t.Fatal("history", err)
	}
	requests, err := os.ReadFile(filepath.Join(c.Directory, "requests.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"thread/start", "turn/start"} {
		if strings.Count(string(requests), `"method":"`+method+`"`) != 1 {
			t.Fatalf("%s replayed", method)
		}
	}
}

func TestUnifiedAdapterInterruptAndWaiting(t *testing.T) {
	c := fixtureConfig(t, "running")
	c.ExecutionID = "execution-fixture"
	a := New(c)
	defer a.Close()
	var adapter agent.Adapter = a
	if err := adapter.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := adapter.SubmitInput(context.Background(), `{"description":"task","generation":1}`); err != nil {
		t.Fatal(err)
	}
	if stopped, known, err := adapter.Abort(); stopped || known || err != nil {
		t.Fatalf("ACK is not settlement: %v %v %v", stopped, known, err)
	}
	if out := drainTerminal(t, adapter); !out.Exited || !out.Uncertain {
		t.Fatalf("interrupted output: %+v", out)
	}
	if stopped, known := a.StopStatus(); !stopped || known {
		t.Fatal("lost late stop evidence")
	}
	a.emit(Event{Settled: true, Final: `{"baton_waiting_for_children":true}`})
	if outputs := adapter.Drain(); len(outputs) != 1 || !outputs[0].WaitingForChildren || outputs[0].Exited || outputs[0].Uncertain {
		t.Fatalf("waiting became a final result: %+v", outputs)
	}
}

func TestUnifiedAdapterDeliveryUsesTurnState(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(map[bool]string{false: "start", true: "steer"}[active], func(t *testing.T) {
			c := fixtureConfig(t, "running")
			a := New(c)
			defer a.Close()
			ctx := context.Background()
			if err := a.Start(ctx); err != nil {
				t.Fatal(err)
			}
			if active {
				if err := a.StartTask(ctx, "operation-1", "task"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := a.DeliverResult(ctx, "delivery-1", `{"delivery_id":"wrong"}`); err == nil {
				t.Fatal("accepted wrong identity")
			}
			if _, err := a.DeliverResult(ctx, "delivery-1", `{"delivery_id":"delivery-1"}`); err != nil {
				t.Fatal(err)
			}
			if _, err := a.DeliverResult(ctx, "delivery-1", `{"delivery_id":"delivery-1"}`); !errors.Is(err, ErrUncertain) {
				t.Fatalf("resent an unconfirmed input: %v", err)
			}
			requests, err := os.ReadFile(filepath.Join(c.Directory, "requests.jsonl"))
			if err != nil {
				t.Fatal(err)
			}
			method := "turn/start"
			if active {
				method = "turn/steer"
			}
			if strings.Count(string(requests), `"method":"`+method+`"`) != 1 {
				t.Fatal("wrong delivery route", string(requests))
			}
		})
	}
}

func TestUnifiedHistoryConfirmsOnlyPersistedInput(t *testing.T) {
	for _, tc := range []struct {
		name, item    string
		queried, want bool
	}{
		{"client-id", `{"type":"userMessage","clientId":"delivery-1"}`, false, true},
		{"user-envelope", `{"type":"userMessage","content":[{"text":"{\"delivery_id\":\"delivery-1\"}"}]}`, false, true},
		{"successful-query", `{"type":"commandExecution","exitCode":0,"aggregatedOutput":"{\"delivery_id\":\"delivery-1\"}"}`, true, true},
		{"failed-query", `{"type":"commandExecution","exitCode":1,"aggregatedOutput":"{\"delivery_id\":\"delivery-1\"}"}`, true, false},
		{"assistant-not-input", `{"type":"agentMessage","text":"{\"delivery_id\":\"delivery-1\"}"}`, false, false},
		{"wrong-role", `{"type":"userMessage","clientId":"delivery-1"}`, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := fixtureConfig(t, "paged")
			raw := `{"data":[{"turnId":"turn-fixture","item":` + tc.item + `}]}`
			if err := os.WriteFile(filepath.Join(c.Directory, "history-items.json"), []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			a := New(c)
			defer a.Close()
			if err := a.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			found, err := a.HistoryContains("delivery-1", tc.queried)
			if err != nil || found != tc.want {
				t.Fatalf("confirmation: found=%v want=%v err=%v", found, tc.want, err)
			}
		})
	}
}
