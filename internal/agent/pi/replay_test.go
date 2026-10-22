package pi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/pi/pireplaytest"
	"baton/internal/agent/replay"
)

func waitPi(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("等待 Pi 状态超时")
}

func TestPiReplayHistoryBeforeInbound(t *testing.T) {
	binary := pireplaytest.Build(t, "../../../tools/agent-replay")
	tape := pireplaytest.Tape(t, "testdata/replay", "simple")
	gates := []string{pireplaytest.LastExit(tape, 2)}
	for _, e := range tape.Entries {
		if e.Type == "emit_inbound" && e.Process == 2 {
			gates = append(gates, e.Label)
		}
	}
	f := pireplaytest.New(t, binary, tape, t.TempDir(), "22222222-2222-4222-8222-222222222222", t.TempDir(), gates...)
	a := New(f.Agent)
	defer func() {
		for _, l := range gates {
			f.Release(t, l)
		}
		_ = a.Close()
	}()
	done := make(chan error, 1)
	go func() {
		err := a.Start(context.Background())
		if err == nil {
			err = a.Send(context.Background(), "message", "task", "")
		}
		done <- err
	}()
	history := ""
	for _, e := range tape.Entries {
		if e.Process != 2 {
			continue
		}
		if e.Type == "native_history" {
			history += e.Append
		}
		if e.Type != "emit_inbound" {
			continue
		}
		f.Wait(t, e.Label)
		files, err := filepath.Glob(filepath.Join(f.Agent.SessionDir, "*.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		if history == "" {
			if len(files) != 0 {
				t.Fatal("录制尚未写历史却出现文件")
			}
		} else {
			if len(files) != 1 {
				t.Fatalf("历史文件: %v", files)
			}
			raw, err := os.ReadFile(files[0])
			if err != nil {
				t.Fatal(err)
			}
			var want strings.Builder
			for _, line := range strings.Split(strings.TrimSuffix(history, "\n"), "\n") {
				expanded, err := replay.Expand(json.RawMessage(line), f.Replay.Bindings, f.Captures(t))
				if err != nil {
					t.Fatal(err)
				}
				want.Write(expanded)
				want.WriteByte('\n')
			}
			if string(raw) != want.String() {
				t.Fatalf("%s 前历史未按录制顺序落盘", e.Label)
			}
		}
		if e.Label == "event:agent_settled" && !a.active {
			t.Fatal("结算前报告结果")
		}
		f.Release(t, e.Label)
	}
	if err := <-done; err != nil {
		f.Check(t)
		t.Fatal(err)
	}
	waitPi(t, func() bool {
		for _, e := range a.Drain() {
			if e.Kind == agent.EventTurnEnded {
				return e.Reason == agent.EndCompleted
			}
		}
		return false
	})
	f.Wait(t, pireplaytest.LastExit(tape, 2))
}
