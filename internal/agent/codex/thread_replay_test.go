package codex

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"baton/internal/agent"
	"baton/internal/agent/codex/replaytest"
	"baton/internal/agent/replay"
)

// threadReplayTape derives Thread requests and free text from recorded app-server
// frames. Extra replies exercise delivery order; the source recordings stay intact.
func threadReplayTape(t *testing.T, source string) replay.Transcript {
	t.Helper()
	tape := replaytest.AdapterTape(replaytest.Load(t, "testdata/replay/"+source+".ndjson"))
	tape = replaytest.SelectReads(tape, map[string]bool{"request:thread/items/list:5": true})
	var entries []replay.Entry
	for _, e := range tape.Entries {
		if len(e.Frame) == 0 || (e.Type != "expect_outbound" && e.Type != "emit_inbound") {
			entries = append(entries, e)
			continue
		}
		var f map[string]any
		if err := json.Unmarshal(e.Frame, &f); err != nil {
			t.Fatal(err)
		}
		method, _ := f["method"].(string)
		p, _ := f["params"].(map[string]any)
		if e.Type == "expect_outbound" {
			switch method {
			case "turn/start":
				delete(p, "outputSchema")
			case "thread/resume":
				p["developerInstructions"] = "<any>"
			case "turn/steer":
				p["input"] = textInput("change direction")
			}
		}
		if e.Type == "emit_inbound" && method == "item/completed" {
			if item, ok := p["item"].(map[string]any); ok && item["type"] == "agentMessage" && item["phase"] != "commentary" {
				item["text"] = "free text reply"
			}
		}
		if e.Type == "emit_inbound" && method == "turn/completed" {
			turn := p["turn"].(map[string]any)
			if source == "simple" {
				for _, item := range []map[string]string{
					{"id": "derived-commentary", "type": "agentMessage", "phase": "commentary", "text": "progress"},
					{"id": "derived-first", "type": "agentMessage", "text": "first additional reply"},
					{"id": "derived-second", "type": "agentMessage", "phase": "final_answer", "text": "second additional reply"},
				} {
					raw, _ := json.Marshal(map[string]any{"method": "item/completed", "params": map[string]any{"threadId": p["threadId"], "turnId": turn["id"], "item": item}})
					entries = append(entries, replay.Entry{Type: "emit_inbound", Process: e.Process, Label: "derived:" + item["id"], Frame: raw})
				}
			}
			for _, v := range turn["items"].([]any) {
				item := v.(map[string]any)
				if item["type"] == "agentMessage" && item["phase"] != "commentary" {
					item["text"] = "free text reply"
				}
			}
		}
		e.Frame, _ = json.Marshal(f)
		entries = append(entries, e)
	}
	tape.Entries = entries
	return tape
}

func awaitThreadEnd(t *testing.T, a *Adapter) []agent.Event {
	t.Helper()
	var events []agent.Event
	await(t, func() bool {
		events = append(events, a.DrainEvents()...)
		for _, event := range events {
			if event.Kind == agent.EventUncertain || event.Kind == agent.EventExited {
				t.Fatalf("Unexpected Thread event: %+v", event)
			}
			if event.Kind == agent.EventTurnEnded {
				return true
			}
		}
		return false
	})
	return events
}

func TestThreadRecordedReplay(t *testing.T) {
	binary := replaytest.Build(t, "../../../tools/agent-replay")
	for _, source := range []string{"simple", "deliver_active", "restore_load_only", "interrupt_mid_tool", "interrupt_before_turn_started", "provider_error"} {
		t.Run(source, func(t *testing.T) {
			tape := threadReplayTape(t, source)
			tape, ends := replaytest.EndGates(tape)
			gates := append(append([]string{}, ends...), "event:turn/completed")
			r := replaytest.Prepare(t, binary, tape, gates...)
			c := replayConfig(r)
			a := New(c)
			defer a.Close()
			mustStart(t, a)
			ctx := context.Background()
			if err := a.Send(ctx, "execution-runtime:1", "a plain text question", ""); err != nil {
				t.Fatal(err)
			}
			if err := a.Send(ctx, "another-message", "busy", ""); !errors.Is(err, agent.ErrBusy) {
				t.Fatal(err)
			}
			if source == "deliver_active" || source == "restore_load_only" {
				if err := a.Steer(ctx, "steer-runtime", "change direction"); err != nil {
					t.Fatal(err)
				}
			}
			if strings.HasPrefix(source, "interrupt_") {
				stopped, known, err := a.Abort()
				if err != nil || stopped || known {
					t.Fatalf("Interrupt ACK: %v %v %v", stopped, known, err)
				}
			}
			r.Wait(t, "event:turn/completed")
			r.Release(t, "event:turn/completed")
			events := awaitThreadEnd(t, a)
			if events[0].Kind != agent.EventTurnStarted || events[0].ClientMessageID != "execution-runtime:1" || events[0].NativeSessionID != a.NativeSessionID() {
				t.Fatal(events)
			}
			wantReason := agent.EndCompleted
			if strings.HasPrefix(source, "interrupt_") {
				wantReason = agent.EndStopped
			}
			if source == "provider_error" {
				wantReason = agent.EndFailed
			}
			if last := events[len(events)-1]; last.Kind != agent.EventTurnEnded || last.Reason != wantReason {
				t.Fatalf("Completion: %+v", last)
			}
			if source == "simple" {
				var replies []string
				for _, e := range events {
					if e.Kind == agent.EventReply {
						replies = append(replies, e.Content)
					}
				}
				if strings.Join(replies, "|") != "free text reply|first additional reply|second additional reply" {
					t.Fatal(replies)
				}
			}
			r.Wait(t, ends[0])
			if source == "restore_load_only" {
				id := a.NativeSessionID()
				a.Close()
				c.Restore = true
				a = New(c)
				defer a.Close()
				mustStart(t, a)
				if a.NativeSessionID() != id {
					t.Fatal("Resume replaced native Thread")
				}
				resumed := awaitThreadEnd(t, a)
				if resumed[len(resumed)-1].Reason != agent.EndCompleted {
					t.Fatal(resumed)
				}
				r.Wait(t, ends[1])
			}
		})
	}
}

func TestThreadReplayProcessExitAndLostAcceptance(t *testing.T) {
	binary := replaytest.Build(t, "../../../tools/agent-replay")
	for _, label := range []string{"request:turn/start", "response:turn/start"} {
		t.Run(label, func(t *testing.T) {
			tape := threadReplayTape(t, "simple")
			var err error
			tape, err = tape.CutAfter(label)
			if err != nil {
				t.Fatal(err)
			}
			var gates []string
			if label == "response:turn/start" {
				var gate string
				tape, gate = replaytest.CrashGate(tape)
				gates = append(gates, gate)
			}
			r := replaytest.Prepare(t, binary, tape, gates...)
			a := New(replayConfig(r))
			defer a.Close()
			mustStart(t, a)
			err = a.Send(context.Background(), "message-runtime", "question", "")
			if label == "request:turn/start" && err == nil {
				t.Fatal("Lost response accepted")
			}
			if len(gates) > 0 {
				if err != nil {
					t.Fatal(err)
				}
				r.Wait(t, gates[0])
				r.Release(t, gates[0])
			}
			var exited, uncertain bool
			await(t, func() bool {
				for _, e := range a.DrainEvents() {
					exited = exited || e.Kind == agent.EventExited
					uncertain = uncertain || e.Kind == agent.EventUncertain
					if e.Kind == agent.EventTurnEnded {
						t.Fatal("Process exit settled the Turn")
					}
				}
				return exited && uncertain
			})
			if err := a.Send(context.Background(), "message-runtime", "retry", ""); err == nil {
				t.Fatal("Unconfirmed message was resent")
			}
		})
	}
}
