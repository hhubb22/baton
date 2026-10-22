package gateway_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/kiro"
)

func TestRealKiro(t *testing.T) {
	t.Parallel()
	if os.Getenv("BATON_REAL_KIRO") != "1" {
		t.Skip("设置 BATON_REAL_KIRO=1 运行真实 Kiro")
	}
	binary, err := exec.LookPath("kiro-cli")
	if err != nil {
		t.Fatal(err)
	}
	model := os.Getenv("BATON_REAL_KIRO_MODEL")
	if model == "" {
		model = "gpt-5.6-sol"
	}
	t.Logf("Kiro=%s model=%s", kiro.Version, model)
	tool := realRecordingTool(t)
	for _, name := range append(append([]string{}, realScenarios...), "restore_recall", "supplement_active") {
		t.Run(name, func(t *testing.T) {
			if name == "deliver_active" {
				t.Skip("Kiro 活动第二 prompt 会打断原回合；Worker 忙碌交付通过原工具查询，见场景 README")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer cancel()
			work, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			home, err := os.UserHomeDir()
			if err != nil {
				t.Fatal(err)
			}
			selected := model
			if name == "provider_error" {
				selected = "baton-nonexistent-model"
			}
			recording := newRealRecording(t, tool, "kiro", kiro.Version, selected, binary, map[string]string{"<workspace>": work, "<home>": home})
			c := agent.Config{Binary: recording.binary, Model: selected, Directory: work, SessionID: "baton-kiro-real", ExecutionID: "kiro-real-execution", SessionDir: filepath.Join(work, "native"), StatePath: filepath.Join(work, "native", "state.json")}
			if name == "symlinked_workspace" {
				c.Directory = realSymlinkedWorkspace(t, work)
				recording.bind(t, "<workspace_alias>", c.Directory)
			}
			a := kiro.New(c)
			defer a.Close()
			if err := a.Start(ctx); err != nil {
				if name == "provider_error" {
					return
				}
				t.Fatal(err)
			}
			if name == "restore_missing" {
				s := a.Snapshot()
				s.NativeID = "sess_baton-missing-history"
				writeRealJSON(t, c.StatePath, s)
				a.Close()
				c.Restore = true
				b := kiro.New(c)
				defer b.Close()
				if err := b.Start(ctx); !errors.Is(err, agent.ErrHistoryMissing) {
					t.Fatal("缺失历史被加载或新建", err)
				}
				return
			}
			description := "Use no tools. Return the exact completed JSON result with summary baton-kiro-ok, empty evidence and artifacts with reasons."
			if name == "result_free_text" {
				description = "Use no tools. For this protocol-negative test reply exactly plain-text-only, never JSON."
			}
			if name == "interrupt_mid_tool" || name == "supplement_active" {
				description = "Run a shell command: python3 -c \"import pathlib,time; pathlib.Path('tool-started').write_text('started'); time.sleep(120); pathlib.Path('tool-finished').write_text('finished')\". Do not run in background. Then return completed JSON."
			}
			if name == "restore_load_only" || name == "restore_recall" {
				description = "Run exactly one shell command: printf 'one\\n' >> count.txt . Remember the marker kiwi-saved-history. Your final message must be ONLY this exact JSON, no explanation, commentary or Markdown: {\"status\":\"completed\",\"summary\":\"baton-kiro-ok\",\"evidence\":[],\"evidence_empty_reason\":\"fixture\",\"artifacts\":[],\"artifacts_empty_reason\":\"fixture\",\"error\":null}"
			}
			payload, _ := json.Marshal(map[string]any{"description": description, "generation": 1})
			if _, err := a.SubmitInput(ctx, string(payload)); err != nil {
				t.Fatal(err)
			}
			if name == "supplement_active" {
				waitRealFile(t, ctx, filepath.Join(work, "tool-started"))
				if err := a.Supplement(ctx, "supplement", "The previous task is cancelled. Use no tools. Your final reply MUST be ONLY this exact JSON: {\"status\":\"completed\",\"summary\":\"supplement-ok\",\"evidence\":[],\"evidence_empty_reason\":\"fixture\",\"artifacts\":[],\"artifacts_empty_reason\":\"fixture\",\"error\":null}"); err != nil {
					t.Fatal(err)
				}
				assertRealCompleted(t, nextRealKiro(t, ctx, a), "supplement-ok")
				return
			}
			if name == "interrupt_before_turn_started" || name == "interrupt_mid_tool" {
				if name == "interrupt_mid_tool" {
					waitRealFile(t, ctx, filepath.Join(work, "tool-started"))
				}
				stopped, known, err := a.Abort()
				if err != nil || stopped || known {
					t.Fatal("cancel 提前报告停止", stopped, known, err)
				}
				waitRealStop(t, a)
				if name == "interrupt_mid_tool" {
					time.Sleep(300 * time.Millisecond)
					if _, err := os.Stat(filepath.Join(work, "tool-finished")); !os.IsNotExist(err) {
						t.Fatal("中止工具继续运行")
					}
				}
				return
			}
			out := nextRealKiro(t, ctx, a)
			if name == "provider_error" {
				if out.Final != "" {
					t.Fatal("无效模型输出成功")
				}
				return
			}
			if name == "result_free_text" {
				if json.Valid([]byte(out.Final)) {
					t.Skip("当前模型遵循任务协议返回 JSON；自由文本反例由已提交的 Qwen 真实录制覆盖")
				}
				return
			}
			assertRealCompleted(t, out, "baton-kiro-ok")
			switch name {
			case "interrupt_idle":
				stopped, _, err := a.Abort()
				if err != nil || !stopped {
					t.Fatal(err)
				}
			case "deliver_idle":
				delivery := `{"delivery_id":"kiro-real-delivery","result":{"status":"completed","summary":"child-ok"},"instruction":"Return completed JSON with summary baton-kiro-delivery-ok"}`
				if _, err := a.DeliverResult(ctx, "kiro-real-delivery", delivery); err != nil {
					t.Fatal(err)
				}
				assertRealCompleted(t, nextRealKiro(t, ctx, a), "baton-kiro-delivery-ok")
				if found, err := a.HistoryContains("kiro-real-delivery", false); err != nil || !found {
					t.Fatal("原生历史没有精确 delivery_id", err)
				}
			case "restore_load_only", "restore_recall":
				before := a.Snapshot()
				a.Close()
				c.Restore = true
				b := kiro.New(c)
				defer b.Close()
				if err := b.Start(ctx); err != nil {
					t.Fatal(err)
				}
				if b.Snapshot().NativeID != before.NativeID {
					t.Fatal("恢复改变身份")
				}
				assertRealOnceOnlyFile(t, work)
				if name == "restore_recall" {
					if err := b.Supplement(ctx, "recall", "The previous task is complete. Do not repeat its command or its result. For this new turn use no tools and reply with ONLY the exact marker you were told to remember, as plain text, without JSON or explanation."); err != nil {
						t.Fatal(err)
					}
					out := nextRealKiro(t, ctx, b)
					if !out.Exited {
						t.Fatal("恢复后未结束回合")
					}
					text := out.Final
					if strings.TrimSpace(text) != "kiwi-saved-history" {
						t.Fatal("恢复后未记住原会话标记")
					}
					assertRealOnceOnlyFile(t, work)
				}
			}
		})
	}
}

func nextRealKiro(t *testing.T, ctx context.Context, a *kiro.Adapter) agent.Output {
	t.Helper()
	for {
		for _, out := range a.Drain() {
			if out.Final != "" && !out.Exited {
				t.Fatal("prompt 响应前发布结果")
			}
			if out.Exited || out.Uncertain || out.WaitingForChildren {
				return out
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("Kiro 未结算")
		case <-time.After(20 * time.Millisecond):
		}
	}
}
