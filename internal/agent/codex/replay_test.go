package codex

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/codex/replaytest"
)

func replayConfig(r *replaytest.Run) Config {
	return Config{Binary: r.Binary, Directory: r.Alias, Home: r.Home, SessionDir: r.Home, SessionID: "session-runtime", StatePath: filepath.Join(r.Home, "native-state.json"), Model: r.Tape.Header.Model}
}

func await(t *testing.T, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("等待事实超时")
}
func mustStart(t *testing.T, a *Adapter) {
	t.Helper()
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func mustInput(t *testing.T, a *Adapter) {
	t.Helper()
	if err := a.Send(context.Background(), "execution-runtime:1", "回放任务", ""); err != nil {
		t.Fatal(err)
	}
}
func awaitOutput(t *testing.T, a *Adapter) []agent.Event { t.Helper(); return awaitThreadEnd(t, a) }
func successful(t *testing.T, events []agent.Event) {
	t.Helper()
	if len(events) == 0 || events[len(events)-1].Kind != agent.EventTurnEnded || events[len(events)-1].Reason != agent.EndCompleted {
		t.Fatal(events)
	}
}
