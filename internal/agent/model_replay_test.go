package agent_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/codex"
	"baton/internal/agent/codex/replaytest"
	"baton/internal/agent/pi"

	"github.com/google/uuid"
)

func TestRecordedThreadModelSwitch(t *testing.T) {
	binary := replaytest.Build(t, "../../tools/agent-replay")
	for _, kind := range []string{"pi", "codex"} {
		t.Run(kind, func(t *testing.T) {
			tape := replaytest.Load(t, filepath.Join(kind, "testdata", "replay", "model_switch.ndjson"))
			r := replaytest.Prepare(t, binary, tape)
			c := agent.Config{Binary: r.Binary, Directory: r.Work, Home: r.Home, Model: tape.Header.Model, SessionID: uuid.NewString(), SessionDir: filepath.Join(r.Work, "native"), StatePath: filepath.Join(r.Work, "state.json")}
			var a agent.Adapter
			var models func(context.Context) (agent.ModelCatalog, error)
			next := "gpt-6-luna"
			if kind == "pi" {
				p := pi.New(c)
				a, models, next = p, p.Models, "openai/gpt-6-luna"
			} else {
				p := codex.New(c)
				a, models = p, p.Models
			}
			defer a.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := a.Start(ctx); err != nil {
				t.Fatal(err)
			}
			catalog, err := models(ctx)
			if err != nil {
				t.Fatal(err)
			}
			for _, id := range []string{c.Model, next} {
				found := false
				for _, m := range catalog.Models {
					found = found || m.ID == id
				}
				if !found {
					t.Fatalf("真实目录缺少指定模型 %s", id)
				}
			}
			if catalog.DefaultModel != c.Model {
				t.Fatalf("真实默认模型: %q", catalog.DefaultModel)
			}
			native := a.(agent.SessionIDProvider).NativeSessionID()
			for i, model := range []string{"", next} {
				if err := a.Send(ctx, []string{"model-message-1", "model-message-2"}[i], "Replay model continuity", model); err != nil {
					t.Fatal(err)
				}
				waitModelTestTurn(t, ctx, a, native)
				if a.(agent.SessionIDProvider).NativeSessionID() != native {
					t.Fatal("切换模型改变了原生会话")
				}
			}
			verifyNativeModelHistory(t, c, kind, native, []string{c.Model, next})
			if kind == "pi" && a.(*pi.Adapter).Model() != next {
				t.Fatal("Pi 未保留切换后的模型")
			}
			r.Check(t)
		})
	}
}
