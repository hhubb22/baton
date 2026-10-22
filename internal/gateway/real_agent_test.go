package gateway_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/codex"
	"baton/internal/agent/kiro"
	"baton/internal/agent/pi"
)

func TestRealPi(t *testing.T) {
	testRealThreadAgent(t, "pi", func(c agent.Config) agent.Adapter { return pi.New(c) })
}
func TestRealCodex(t *testing.T) {
	testRealThreadAgent(t, "codex", func(c agent.Config) agent.Adapter { return codex.New(c) })
}
func TestRealKiro(t *testing.T) {
	testRealThreadAgent(t, "kiro", func(c agent.Config) agent.Adapter { return kiro.New(c) })
}

func testRealThreadAgent(t *testing.T, kind string, factory func(agent.Config) agent.Adapter) {
	t.Helper()
	prefix := "BATON_" + strings.ToUpper(kind)
	if os.Getenv("BATON_REAL_"+strings.ToUpper(kind)) != "1" {
		t.Skip("需显式启用真实 Agent，并提供隔离目录与模型")
	}
	homePath := os.Getenv("BATON_REAL_" + strings.ToUpper(kind) + "_HOME")
	if kind == "pi" && homePath == "" {
		homePath = t.TempDir()
	}
	home, err := filepath.EvalSymlinks(homePath)
	if err != nil || home == "" {
		t.Fatal("需提供已认证的隔离 HOME")
	}
	tmp, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rel, err := filepath.Rel(tmp, home)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		t.Fatal("真实 Agent HOME 必须位于系统临时目录内")
	}
	model := os.Getenv(prefix + "_MODEL")
	if model == "" {
		t.Fatal("需显式选择真实验证模型")
	}
	binary := os.Getenv(prefix + "_BINARY")
	if kind == "pi" {
		binary = os.Getenv("BATON_PI_BIN")
	}
	if binary == "" {
		binary = kind
	}
	binary, err = exec.LookPath(binary)
	if err != nil {
		t.Fatal(err)
	}
	binary, err = filepath.EvalSymlinks(binary)
	if err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	work, err = filepath.EvalSymlinks(work)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	c := agent.Config{Binary: binary, Home: home, Directory: work, SessionDir: filepath.Join(work, "native"), StatePath: filepath.Join(work, "native", "state.json"), SessionID: newProcessID(t), Model: model}
	if kind == "pi" {
		if runtime.GOOS != "darwin" {
			t.Skip("真实 Pi 验证使用 macOS sandbox-exec")
		}
		profile, wrapper := filepath.Join(work, "pi.sb"), filepath.Join(work, "pi-isolated")
		policy := piSandboxPolicy([]string{home, work, piSandboxRuntimeDir(binary)}, []string{home, work}, filepath.Join(work, "ipc"))
		if err := os.WriteFile(profile, []byte(policy), 0600); err != nil {
			t.Fatal(err)
		}
		writeRealPiWrapper(t, wrapper, profile, binary)
		c.Binary, c.Env = wrapper, pi.IsolatedEnv(home)
	}
	version := map[string]string{"pi": pi.Version, "codex": codex.Version, "kiro": kiro.Version}[kind]
	recording := newRealRecording(t, realRecordingTool(t), kind, version, model, c.Binary, map[string]string{"<home>": home, "<workspace>": work})
	c.Binary = recording.binary
	a := factory(c)
	t.Cleanup(func() { _ = a.Close() })
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	turn := func(id, prompt, want string) {
		t.Helper()
		if err := a.Send(ctx, id, prompt, ""); err != nil {
			t.Fatal(err)
		}
		var replies strings.Builder
		for {
			for _, event := range a.Drain() {
				switch event.Kind {
				case agent.EventReply:
					replies.WriteString(event.Content)
				case agent.EventExited, agent.EventUncertain:
					t.Fatalf("真实 Agent 状态无法确认: %+v", event)
				case agent.EventTurnEnded:
					if event.Reason != agent.EndCompleted || !strings.Contains(replies.String(), want) {
						t.Fatalf("真实回复: reason=%s reply=%q", event.Reason, replies.String())
					}
					return
				}
			}
			select {
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-time.After(50 * time.Millisecond):
			}
		}
	}
	turn("first", "Use no tools. Remember the marker BATON_THREAD_RECALL. Reply with only BATON_THREAD_RECALL.", "BATON_THREAD_RECALL")
	turn("second", "Use no tools. Repeat the marker from my previous message.", "BATON_THREAD_RECALL")
	if !a.Capabilities().Resume {
		return
	}
	id := a.(agent.SessionIDProvider).NativeSessionID()
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	c.Restore = true
	a = factory(c)
	t.Cleanup(func() { _ = a.Close() })
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if resumed := a.(agent.SessionIDProvider).NativeSessionID(); resumed != id {
		t.Fatalf("恢复改变原生会话: %s → %s", id, resumed)
	}
	turn("third", "Use no tools. Recall the marker from our conversation before the restart.", "BATON_THREAD_RECALL")
}
