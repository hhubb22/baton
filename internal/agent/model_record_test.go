package agent_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/codex"
	"baton/internal/agent/pi"
	"baton/internal/agent/replay"
	"github.com/google/uuid"
)

// TestRealThreadModelSwitch 只使用约定的默认模型和 Luna，录制原生目录与同会话两轮输入。
func TestRealThreadModelSwitch(t *testing.T) {
	output := os.Getenv("BATON_MODEL_RECORD_DIR")
	if output == "" {
		t.Skip("设置 BATON_MODEL_RECORD_DIR，在本机运行模型切换录制")
	}
	for _, kind := range []string{"pi", "codex"} {
		t.Run(kind, func(t *testing.T) {
			work := modelTestDirectory(t)
			home := modelTestDirectory(t)
			realHome, err := os.UserHomeDir()
			if err != nil {
				t.Fatal(err)
			}
			c := agent.Config{Directory: work, Home: home, SessionID: uuid.NewString(), SessionDir: filepath.Join(work, "native"), StatePath: filepath.Join(work, "state.json")}
			initial, next, version, protocol := "magpie/auto/gpt-6.1-sol", "openai/gpt-6-luna", pi.Version, "pi-rpc-jsonl"
			if kind == "pi" {
				source := os.Getenv("PI_CODING_AGENT_DIR")
				if source == "" {
					source = filepath.Join(realHome, ".pi", "agent")
				}
				copyModelTestConfig(t, source, filepath.Join(home, "pi"), "auth.json", "models.json", "settings.json")
				if err := os.MkdirAll(filepath.Join(home, "tmp"), 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				initial, next, version, protocol = "gpt-6.1-sol", "gpt-6-luna", codex.Version, "codex-app-server-jsonrpc"
				source := os.Getenv("CODEX_HOME")
				if source == "" {
					source = filepath.Join(realHome, ".codex")
				}
				copyModelTestConfig(t, source, home, "auth.json", "config.toml")
			}
			c.Model = initial
			binary, err := exec.LookPath(kind)
			if err != nil {
				t.Fatal(err)
			}
			tool := filepath.Join(t.TempDir(), "agent-replay.exe")
			cmd := exec.Command("go", "build", "-o", tool, "../../tools/agent-replay")
			if raw, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("构建录制器: %v %s", err, raw)
			}
			recordDir := filepath.Dir(tool)
			rawDir := filepath.Join(recordDir, "raw")
			header := replay.Header{Agent: kind, Protocol: protocol, AgentVersion: version, Platform: runtime.GOOS + "/" + runtime.GOARCH, Model: initial, Scenario: "model_switch", RecordedAt: time.Now().Format("2006-01-02"), Source: "local recording"}
			commit, err := exec.Command("git", "rev-parse", "HEAD").Output()
			if err != nil {
				t.Fatal(err)
			}
			header.BatonCommit = strings.TrimSpace(string(commit))
			writeModelTestJSON(t, filepath.Join(recordDir, "scenario.json"), header)
			recordConfig := replay.RecordConfig{AgentBinary: binary, RawDir: rawDir, RawTempDir: os.TempDir(), ScenarioFile: filepath.Join(recordDir, "scenario.json"), Bindings: map[string]string{"<home>": home, "<workspace>": work}}
			if kind == "codex" {
				recordConfig.HistoryDirs = []string{filepath.Join(home, "sessions")}
				recordConfig.Bindings["<caller_home>"] = realHome
			}
			writeModelTestJSON(t, tool+".record.json", recordConfig)
			c.Binary = tool
			var a agent.ThreadAdapter
			var models func(context.Context) (agent.ModelCatalog, error)
			if kind == "pi" {
				p := pi.New(c)
				a, models = p, p.Models
			} else {
				p := codex.New(c)
				a, models = p, p.Models
			}
			t.Cleanup(func() { a.Close() })
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer cancel()
			if err := a.Start(ctx); err != nil {
				t.Fatal(err)
			}
			catalog, err := models(ctx)
			if err != nil {
				t.Fatalf("%s 模型目录不可用，停止该 Agent 录制: %v", kind, err)
			}
			for _, model := range []string{initial, next} {
				found := false
				for _, m := range catalog.Models {
					found = found || m.ID == model
				}
				if !found {
					t.Fatalf("指定模型 %s 不在原生目录中，停止录制", model)
				}
			}
			native := a.(agent.SessionIDProvider).NativeSessionID()
			for i, model := range []string{"", next} {
				text := "Reply with exactly BATON_MODEL_ONE. Do not use tools."
				if i == 1 {
					text = "Repeat the exact marker from my previous message. Do not use tools."
				}
				if err := a.Send(ctx, []string{"model-message-1", "model-message-2"}[i], text, model); err != nil {
					t.Fatal(err)
				}
				waitModelTestTurn(t, ctx, a, native)
				if a.(agent.SessionIDProvider).NativeSessionID() != native {
					t.Fatal("切换模型改变了原生会话")
				}
			}
			verifyNativeModelHistory(t, c, kind, native, []string{initial, next})
			if err := a.Close(); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Join(output, kind), 0700); err != nil {
				t.Fatal(err)
			}
			cmd = exec.Command(tool, "normalize", "--input", filepath.Join(rawDir, "model_switch.raw.ndjson"), "--output", filepath.Join(output, kind, "model_switch.ndjson"))
			if raw, err := cmd.CombinedOutput(); err != nil {
				failedDir, keepErr := os.MkdirTemp("", "baton-model-normalization-")
				if keepErr == nil {
					data, readErr := os.ReadFile(filepath.Join(rawDir, "model_switch.raw.ndjson"))
					if readErr == nil {
						keepErr = os.WriteFile(filepath.Join(failedDir, "model_switch.raw.ndjson"), data, 0600)
					} else {
						keepErr = readErr
					}
				}
				t.Fatalf("规范化: %v %s；临时原始录制=%s，保存错误=%v", err, raw, failedDir, keepErr)
			}
			t.Logf("%s: %s -> %s；目录 %d 项；同一原生会话两轮完成", kind, initial, next, len(catalog.Models))
		})
	}
}

func modelTestDirectory(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func copyModelTestConfig(t *testing.T, source, target string, names ...string) {
	t.Helper()
	if err := os.MkdirAll(target, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(source, name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			t.Fatalf("读取本机 %s 失败", name)
		}
		if err := os.WriteFile(filepath.Join(target, name), raw, 0600); err != nil {
			t.Fatalf("准备隔离配置 %s 失败", name)
		}
	}
}

func writeModelTestJSON(t *testing.T, path string, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func waitModelTestTurn(t *testing.T, ctx context.Context, a agent.ThreadAdapter, native string) {
	t.Helper()
	started, reply := false, false
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		for _, e := range a.DrainEvents() {
			switch e.Kind {
			case agent.EventTurnStarted:
				started = true
				if e.NativeSessionID != native {
					t.Fatal("Turn 原生会话 ID 错误")
				}
			case agent.EventReply:
				reply = reply || strings.Contains(e.Content, "BATON_MODEL_ONE")
			case agent.EventTurnEnded:
				if !started || !reply || e.Reason != agent.EndCompleted {
					t.Fatalf("Turn 未完成或没有回忆标记: %+v", e)
				}
				return
			case agent.EventUncertain, agent.EventExited:
				t.Fatalf("Turn 没有确认完成: %+v", e)
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
}
