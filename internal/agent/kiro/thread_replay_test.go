package kiro_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/kiro"
	"baton/internal/agent/kiro/kiroreplaytest"
	"baton/internal/agent/replay"
)

func TestThreadRecordedKiro(t *testing.T) {
	binary := kiroreplaytest.Build(t, "../../../tools/agent-replay")
	for _, scenario := range []string{"restore_load_only", "interrupt_mid_tool", "failed"} {
		t.Run(scenario, func(t *testing.T) {
			template := kiroreplaytest.Load(t, "testdata/replay/restore_load_only.ndjson")
			fixture := scenario
			if scenario == "failed" {
				fixture = "restore_load_only"
			}
			tape := kiroreplaytest.Load(t, "testdata/replay/"+fixture+".ndjson")
			var entries []replay.Entry
			for _, e := range tape.Entries {
				if e.Process <= 2 {
					if scenario == "failed" {
						e.Frame = bytes.ReplaceAll(e.Frame, []byte(`"stopReason":"end_turn"`), []byte(`"stopReason":"max_tokens"`))
					}
					entries = append(entries, e)
				}
			}
			// The first independent load reads the pre-send history. Later loads
			// replay the persisted user message and the recorded assistant replies.
			for read := 0; read < 7; read++ {
				for _, e := range template.Entries {
					if e.Process < 3 || e.Process > 4 {
						continue
					}
					e.Process += read * 2
					if e.Label != "" {
						e.Label += strings.Repeat(":read", read+1)
					}
					e.Frame = bytes.ReplaceAll(e.Frame, []byte("<$request_id_"), []byte("<$history"+strings.Repeat("x", read)+"_"))
					var frame struct {
						Method string
						Params struct {
							Update struct {
								Kind string `json:"sessionUpdate"`
							} `json:"update"`
						}
					}
					_ = json.Unmarshal(e.Frame, &frame)
					if read == 0 && frame.Method == "session/update" {
						continue
					}
					if frame.Params.Update.Kind == "user_message_chunk" {
						e.Frame = bytes.ReplaceAll(e.Frame, []byte("<any>"), []byte("thread prompt"))
					}
					entries = append(entries, e)
				}
			}
			tape.Entries = entries
			tape, ends := kiroreplaytest.EndGates(tape)
			gates := append([]string{}, ends...)
			if scenario != "interrupt_mid_tool" {
				gates = append(gates, "response:session/prompt")
			} else {
				gates = append(gates, "notification:session/cancel")
			}
			r := kiroreplaytest.Prepare(t, binary, tape, gates...)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			config := agent.Config{Binary: r.Binary, Home: r.Home, Directory: r.Work, SessionDir: filepath.Join(r.Work, "native"), StatePath: filepath.Join(r.Work, "native", "state.json"), SessionID: "thread-session", Model: tape.Header.Model}
			a := kiro.New(config)
			defer a.Close()
			if err := a.Start(ctx); err != nil {
				t.Fatal(err)
			}
			if a.NativeSessionID() != "native-session-1" || a.Capabilities() != (agent.Capabilities{Resume: true}) {
				t.Fatal("invalid capabilities/session")
			}
			if err := a.Send(ctx, "message-1", "thread prompt"); err != nil {
				t.Fatal(err)
			}
			gate := "response:session/prompt"
			if scenario == "interrupt_mid_tool" {
				gate = "notification:session/cancel"
			}
			r.Wait(t, gate)
			if err := a.Send(ctx, "busy", "ignored"); !errors.Is(err, agent.ErrBusy) {
				t.Fatal(err)
			}
			if err := a.Steer(ctx, "steer", "ignored"); !errors.Is(err, agent.ErrUnsupported) {
				t.Fatal(err)
			}
			r.Release(t, gate)
			wantReason := agent.EndCompleted
			if scenario == "failed" {
				wantReason = agent.EndFailed
			}
			if scenario == "interrupt_mid_tool" {
				if _, _, err := a.Abort(); err != nil {
					t.Fatal(err)
				}
				wantReason = agent.EndStopped
			}
			var events []agent.Event
			ended := false
			for !ended {
				for _, e := range a.DrainEvents() {
					events = append(events, e)
					if e.Kind == agent.EventTurnEnded {
						ended = true
						if e.Reason != wantReason {
							t.Fatal(e)
						}
					}
				}
				select {
				case <-ctx.Done():
					t.Fatal("turn did not end", events)
				case <-time.After(time.Millisecond):
				}
			}
			if events[0].Kind != agent.EventTurnStarted || events[0].ClientMessageID != "message-1" {
				t.Fatal(events)
			}
			if scenario == "restore_load_only" {
				var replies []string
				for _, e := range events {
					if e.Kind == agent.EventReply {
						replies = append(replies, e.Content)
					}
				}
				if len(replies) != 2 || !strings.Contains(replies[0], "I'll execute") || !strings.Contains(replies[1], "baton-kiro-ok") {
					t.Fatal(replies)
				}
			}
			if sent, err := a.Sent("message-1"); err != nil || !sent {
				t.Fatal(sent, err)
			}
			if count, err := a.UserMessageCount(); err != nil || count != 1 {
				t.Fatal(count, err)
			}
			for _, end := range ends {
				r.Wait(t, end)
			}
			if err := a.Close(); err != nil {
				t.Fatal(err)
			}
			config.Restore = true
			b := kiro.New(config)
			defer b.Close()
			if err := b.Start(ctx); err != nil {
				t.Fatal(err)
			}
			if len(b.DrainEvents()) != 0 {
				t.Fatal("load replay became a new turn")
			}
			b.RestoreIntent("restored", "thread prompt", 0)
			if sent, err := b.Sent("restored"); err != nil || !sent {
				t.Fatal(sent, err)
			}
			b.RestoreIntent("old-match", "thread prompt", 1)
			if sent, err := b.Sent("old-match"); err != nil || sent {
				t.Fatal("matched before the intent position", sent, err)
			}
			b.RestoreIntent("different", "different text", 0)
			if sent, err := b.Sent("different"); err != nil || sent {
				t.Fatal("matched a different user message", sent, err)
			}
		})
	}
}
