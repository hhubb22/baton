package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"baton/internal/agent"
	"baton/internal/privatefile"
)

func TestThreadRequestsAndLifecycle(t *testing.T) {
	c := Config{Directory: t.TempDir(), StatePath: filepath.Join(t.TempDir(), "state.json"), ExecutionID: "legacy-config"}
	a := New(c)
	requests := make(chan string, 8)
	turnCount := 0
	unitRPC(t, a, func(method string, raw json.RawMessage) (any, error) {
		requests <- method
		var p map[string]any
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		switch method {
		case "thread/start":
			instructions, _ := p["developerInstructions"].(string)
			if p["approvalPolicy"] != "never" || p["sandbox"] != "workspace-write" || !strings.Contains(instructions, "Baton Thread") || !strings.Contains(instructions, a.config.Directory) || strings.Contains(instructions, "JSON") {
				t.Errorf("Thread environment: %s", raw)
			}
			return map[string]any{"thread": map[string]string{"id": "native-thread"}}, nil
		case "turn/start":
			turnCount++
			if _, exists := p["outputSchema"]; exists || p["clientUserMessageId"] != fmt.Sprintf("message-%d", turnCount) {
				t.Errorf("Thread input: %s", raw)
			}
			return map[string]any{"turn": map[string]string{"id": fmt.Sprintf("turn-%d", turnCount), "status": "inProgress"}}, nil
		case "turn/steer":
			if p["expectedTurnId"] != "turn-1" || p["clientUserMessageId"] != "steer-1" || p["threadId"] != "native-thread" {
				t.Errorf("Steer identity: %s", raw)
			}
			if _, exists := p["outputSchema"]; exists {
				t.Errorf("Steer constrained output: %s", raw)
			}
			return map[string]string{"turnId": "turn-1"}, nil
		case "turn/interrupt":
			if p["turnId"] != "turn-1" {
				t.Errorf("Interrupt identity: %s", raw)
			}
			return map[string]any{}, nil
		default:
			return nil, fmt.Errorf("unexpected request: %s", method)
		}
	})
	ctx := context.Background()
	if got := a.Capabilities(); got != (agent.Capabilities{Steer: true, Resume: true}) {
		t.Fatal(got)
	}
	mustStart(t, a)
	if a.NativeSessionID() != "native-thread" {
		t.Fatal(a.NativeSessionID())
	}
	if err := a.Steer(ctx, "idle-steer", "text"); !errors.Is(err, agent.ErrBusy) {
		t.Fatal(err)
	}
	if err := a.Send(ctx, "message-1", "first question"); err != nil {
		t.Fatal(err)
	}
	if err := a.Send(ctx, "busy", "second question"); !errors.Is(err, agent.ErrBusy) {
		t.Fatal(err)
	}
	started := json.RawMessage(`{"threadId":"native-thread","turn":{"id":"turn-1","status":"inProgress"}}`)
	a.notification("turn/started", started)
	a.notification("turn/started", started)
	if err := a.Steer(ctx, "steer-1", "change direction"); err != nil {
		t.Fatal(err)
	}
	for _, item := range []string{
		`{"id":"comment","type":"agentMessage","phase":"commentary","text":"progress"}`,
		`{"id":"first","type":"agentMessage","phase":"final_answer","text":"first reply"}`,
		`{"id":"second","type":"agentMessage","text":"second reply"}`,
	} {
		a.notification("item/completed", json.RawMessage(`{"threadId":"native-thread","turnId":"turn-1","item":`+item+`}`))
	}
	stopped, known, err := a.Abort()
	if err != nil || stopped || known {
		t.Fatalf("Interrupt ACK: %v %v %v", stopped, known, err)
	}
	if stopped, _ := a.StopStatus(); stopped {
		t.Fatal("Interrupt ACK confirmed settlement")
	}
	completed := json.RawMessage(`{"threadId":"native-thread","turn":{"id":"turn-1","status":"interrupted","items":[{"id":"second","type":"agentMessage","text":"second reply"}]}}`)
	a.notification("turn/completed", completed)
	a.notification("turn/completed", completed)
	a.notification("turn/started", started)
	if stopped, _ := a.StopStatus(); !stopped {
		t.Fatal("Missing stop observation")
	}
	if outputs := a.Drain(); len(outputs) != 0 {
		t.Fatal("Thread notifications entered legacy output queue", outputs)
	}
	events := a.DrainEvents()
	if len(events) != 4 || events[0].Kind != agent.EventTurnStarted || events[0].ClientMessageID != "message-1" || events[0].NativeSessionID != "native-thread" || events[1].Content != "first reply" || events[2].Content != "second reply" || events[3].Kind != agent.EventTurnEnded || events[3].Reason != agent.EndStopped {
		t.Fatalf("Thread events: %+v", events)
	}
	if events := a.DrainEvents(); len(events) != 0 {
		t.Fatal(events)
	}
	if err := a.Send(ctx, "message-2", "next turn"); err != nil {
		t.Fatal(err)
	}
	want := []string{"thread/start", "turn/start", "turn/steer", "turn/interrupt", "turn/start"}
	var got []string
	for len(requests) > 0 {
		got = append(got, <-requests)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Requests: %v", got)
	}
}

func TestThreadCompletionReasonsAndIdentity(t *testing.T) {
	for status, reason := range map[string]string{"completed": agent.EndCompleted, "interrupted": agent.EndStopped, "failed": agent.EndFailed} {
		t.Run(status, func(t *testing.T) {
			a := New(Config{StatePath: filepath.Join(t.TempDir(), "state.json")})
			defer a.Close()
			a.state = State{ThreadID: "thread", TurnID: "turn", ThreadMode: true, Pending: true, OperationID: "message"}
			a.active = true
			a.notification("turn/completed", json.RawMessage(`{"threadId":"other","turn":{"id":"turn","status":"completed"}}`))
			a.notification("turn/completed", json.RawMessage(`{"threadId":"thread","turn":{"id":"other","status":"completed"}}`))
			if events := a.DrainEvents(); len(events) != 0 {
				t.Fatal(events)
			}
			a.notification("turn/completed", json.RawMessage(`{"threadId":"thread","turn":{"id":"turn","status":"`+status+`","items":[]}}`))
			events := a.DrainEvents()
			if len(events) != 2 || events[0].Kind != agent.EventTurnStarted || events[1].Kind != agent.EventTurnEnded || events[1].Reason != reason {
				t.Fatal(events)
			}
		})
	}
}

func TestThreadNativeSentAcrossAdapterRestart(t *testing.T) {
	for _, tc := range []struct {
		name, record string
		want         bool
	}{
		{"camel-case", `{"type":"response_item","payload":{"type":"message","role":"user","clientUserMessageId":"message-1"}}`, true},
		{"native-snake-case", `{"type":"response_item","payload":{"type":"message","role":"user","client_user_message_id":"message-1"}}`, true},
		{"native-event", `{"type":"event_msg","payload":{"type":"user_message","client_user_message_id":"message-1"}}`, true},
		{"client-id", `{"type":"response_item","payload":{"type":"message","role":"user","clientId":"message-1"}}`, true},
		{"substring", `{"type":"response_item","payload":{"type":"message","role":"user","clientUserMessageId":"message-10"}}`, false},
		{"assistant", `{"type":"response_item","payload":{"type":"message","role":"assistant","clientUserMessageId":"message-1"}}`, false},
		{"quoted-id", `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"message-1"}]}}`, false},
		{"unrelated-record", `{"type":"event_msg","payload":{"type":"agent_message","clientUserMessageId":"message-1"}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, saved := nativeSentFixture(t, tc.record+"\n")
			a := New(c)
			// No Start or live transport: only the durable mapping and native file exist.
			defer a.Close()
			if found, err := a.Sent("message-1"); err != nil || found != tc.want {
				t.Fatalf("Sent: %v %v (%s)", found, err, saved.HistoryPath)
			}
			if found, err := a.Sent(""); err != nil || found {
				t.Fatal(found, err)
			}
		})
	}
}

func nativeSentFixture(t *testing.T, body string) (Config, State) {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c := Config{Directory: dir, SessionID: "baton-thread", StatePath: filepath.Join(dir, "state.json")}
	s := State{ThreadID: "native-thread", SessionID: c.SessionID, Directory: dir, Version: Version, HistoryRoot: dir, HistoryPath: filepath.Join(dir, "history.jsonl"), ThreadMode: true}
	header, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]string{"id": s.ThreadID, "cwd": dir, "cli_version": s.Version}})
	if err := os.WriteFile(s.HistoryPath, append(append(header, '\n'), []byte(body)...), 0600); err != nil {
		t.Fatal(err)
	}
	writeSentState(t, c, s)
	return c, s
}

func writeSentState(t *testing.T, c Config, s State) {
	t.Helper()
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if err := privatefile.WriteFile(c.StatePath, raw); err != nil {
		t.Fatal(err)
	}
}

func TestThreadNativeSentRejectsMissingAndUnsafeHistory(t *testing.T) {
	for _, name := range []string{"missing", "escape", "symlink", "directory", "wrong-thread", "wrong-cwd", "wrong-version", "malformed", "partial"} {
		t.Run(name, func(t *testing.T) {
			c, s := nativeSentFixture(t, "")
			switch name {
			case "missing":
				if err := os.Remove(s.HistoryPath); err != nil {
					t.Fatal(err)
				}
			case "escape":
				s.HistoryPath = filepath.Join(t.TempDir(), "outside.jsonl")
			case "symlink":
				link := filepath.Join(s.HistoryRoot, "link.jsonl")
				if err := os.Symlink(filepath.Join(t.TempDir(), "outside.jsonl"), link); err != nil {
					t.Skip(err)
				}
				s.HistoryPath = link
			case "directory":
				s.HistoryPath = s.HistoryRoot
			case "wrong-thread":
				s.ThreadID = "other-thread"
			case "wrong-cwd":
				s.Directory = t.TempDir()
			case "wrong-version":
				s.Version = "0.162.1"
			case "malformed", "partial":
				f, err := os.OpenFile(s.HistoryPath, os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					t.Fatal(err)
				}
				body := "{invalid}\n"
				if name == "partial" {
					body = `{"type":"response_item"`
				}
				_, err = f.WriteString(body)
				closeErr := f.Close()
				if err != nil || closeErr != nil {
					t.Fatal(err, closeErr)
				}
			}
			writeSentState(t, c, s)
			a := New(c)
			defer a.Close()
			if found, err := a.Sent("message-1"); found || err == nil {
				t.Fatalf("Unsafe history accepted: %v %v", found, err)
			}
		})
	}
}

func TestThreadEventOverflowReportsUncertainty(t *testing.T) {
	a := New(Config{})
	defer a.Close()
	for range 200 {
		a.emitThread(agent.Event{Kind: agent.EventReply, Content: "reply"})
	}
	events := a.DrainEvents()
	if len(events) != 128 || events[len(events)-1].Kind != agent.EventUncertain {
		t.Fatal("Missing bounded overflow signal", len(events))
	}
	waitConnectionFact(t, a.closed)
}
