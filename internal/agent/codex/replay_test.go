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
	"baton/internal/agent/codex/replaytest"
	"baton/internal/privatefile"
	"baton/internal/task"
)

func replayConfig(r *replaytest.Run) Config {
	return Config{Binary: r.Binary, Directory: r.Alias, Home: r.Home, SessionDir: r.Home, SessionID: "session-runtime", ExecutionID: "execution-runtime", StatePath: filepath.Join(r.Home, "native-state.json"), Model: r.Tape.Header.Model}
}
func awaitOutput(t *testing.T, a *Adapter) agent.Output {
	t.Helper()
	var found agent.Output
	await(t, func() bool {
		for _, out := range a.Drain() {
			if out.Exited || out.Uncertain {
				found = out
				return true
			}
		}
		return false
	})
	return found
}
func await(t *testing.T, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
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
	if out, err := a.SubmitInput(context.Background(), `{"description":"回放任务","generation":1}`); err != nil || out.Final != "" {
		t.Fatalf("提交任务: %+v %v", out, err)
	}
}
func successful(t *testing.T, out agent.Output) {
	t.Helper()
	if !out.Exited || out.Uncertain {
		t.Fatalf("完成状态: %+v", out)
	}
	if _, err := task.ParseCandidate(out.Final); err != nil {
		t.Fatalf("结构化结果: %s %v", out.Final, err)
	}
}

func TestRecordedCodexScenarios(t *testing.T) {
	binary := replaytest.Build(t, "../../../tools/agent-replay")
	paths, err := filepath.Glob("testdata/replay/*.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		t.Run(strings.TrimSuffix(filepath.Base(path), ".ndjson"), func(t *testing.T) {
			tape := replaytest.AdapterTape(replaytest.Load(t, path))
			tape, ends := replaytest.EndGates(tape)
			scenario := tape.Header.Scenario
			gates := append([]string{}, ends...)
			if scenario == "interrupt_mid_tool" {
				gates = append(gates, "event:turn/moderationMetadata")
			}
			if scenario != "restore_missing" {
				gates = append(gates, "event:turn/completed")
			}
			r := replaytest.Prepare(t, binary, tape, gates...)
			c := replayConfig(r)
			a := New(c)
			defer a.Close()
			ctx := context.Background()
			if scenario == "restore_missing" {
				// 录制的恢复目标从未存在，不允许创建替代 thread。
				f := replaytest.Frame(t, tape, "request:thread/read")
				id := f["params"].(map[string]any)["threadId"].(string)
				state := State{Version: Version, ThreadID: id, SessionID: c.SessionID, Directory: r.Work}
				raw, _ := json.Marshal(state)
				if err := privatefile.WriteFile(c.StatePath, raw); err != nil {
					t.Fatal(err)
				}
				c.Restore = true
				a.Close()
				a = New(c)
				defer a.Close()
				if err := a.Start(ctx); err == nil {
					t.Fatal("缺失历史被恢复")
				}
				r.Wait(t, ends[0])
				return
			}
			mustStart(t, a)
			mustInput(t, a)
			if scenario == "interrupt_mid_tool" || scenario == "interrupt_before_turn_started" {
				// 转录在工具开始后等待 interrupt；完成事件另设门，分开 ACK 与停止证据。
				if scenario == "interrupt_mid_tool" {
					r.Wait(t, "event:turn/moderationMetadata")
					r.Release(t, "event:turn/moderationMetadata")
				}
				stopped, known, err := a.Abort()
				if err != nil || stopped || known {
					t.Fatalf("中止 ACK: %v %v %v", stopped, known, err)
				}
				if stopped, _ := a.StopStatus(); stopped {
					t.Fatal("ACK 被作为停止证据")
				}
			}
			if scenario == "deliver_active" || scenario == "restore_load_only" || scenario == "deliver_idle" {
				if scenario == "deliver_idle" {
					r.Wait(t, "event:turn/completed")
					r.Release(t, "event:turn/completed")
					successful(t, awaitOutput(t, a))
				}
				if found, err := a.HistoryContains("delivery-runtime", false); err != nil || found {
					t.Fatalf("交付前历史: %v %v", found, err)
				}
				method := "request:turn/steer"
				if scenario == "deliver_idle" {
					method = "request:turn/start:2"
				}
				f := replaytest.Frame(t, tape, method)
				text := f["params"].(map[string]any)["input"].([]any)[0].(map[string]any)["text"].(string)
				text = strings.ReplaceAll(text, "<$delivery_id_1>", "delivery-runtime")
				if _, err := a.DeliverResult(ctx, "delivery-runtime", `{"delivery_id":"wrong"}`); err == nil {
					t.Fatal("接受错误交付身份")
				}
				if _, err := a.DeliverResult(ctx, "delivery-runtime", text); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "delegation" {
				id := replaytest.QueriedDelivery(t, tape)
				if found, err := a.HistoryContains(id, true); err != nil || found {
					t.Fatalf("wait 嵌套输出提前确认: %v %v", found, err)
				}
				if found, err := a.HistoryContains(id, true); err != nil || !found {
					t.Fatalf("result 输出未确认: %v %v", found, err)
				}
			}

			if scenario != "deliver_idle" {
				r.Wait(t, "event:turn/completed")
				if scenario != "interrupt_mid_tool" && scenario != "interrupt_before_turn_started" && scenario != "provider_error" {
					await(t, func() bool { a.mu.Lock(); defer a.mu.Unlock(); return a.final != "" })
				}
				for _, out := range a.Drain() {
					if out.Final != "" || out.Exited {
						t.Fatalf("结算前输出最终结果: %+v", out)
					}
				}
				r.Release(t, "event:turn/completed")
			}
			out := awaitOutput(t, a)
			switch scenario {
			case "interrupt_mid_tool", "interrupt_before_turn_started":
				if !out.Uncertain || !out.Exited {
					t.Fatalf("中止结果: %+v", out)
				}
				if stopped, known := a.StopStatus(); !stopped || known {
					t.Fatalf("迟到停止证据: %v %v", stopped, known)
				}
			case "provider_error":
				if !out.Uncertain || out.Final != "" {
					t.Fatalf("供应商错误被判成功: %+v", out)
				}
			default:
				successful(t, out)
			}
			if scenario == "interrupt_idle" {
				if stopped, known, err := a.Abort(); err != nil || !stopped || known {
					t.Fatalf("空闲中止: %v %v %v", stopped, known, err)
				}
			}
			if scenario == "deliver_active" || scenario == "restore_load_only" || scenario == "deliver_idle" {
				if found, err := a.HistoryContains("delivery-runtime", false); err != nil || !found {
					t.Fatalf("缺少精确交付历史: %v %v", found, err)
				}
				if page, err := a.ReadHistory(ctx, ""); err != nil || !json.Valid(page.Data) {
					t.Fatal("历史不可读", err)
				}
			}
			if _, err := a.SubmitInput(ctx, `{"description":"重复任务","generation":1}`); !errors.Is(err, ErrUncertain) {
				t.Fatalf("任务被重发: %v", err)
			}
			if scenario == "interrupt_before_turn_started" {
				if page, err := a.ReadHistory(ctx, ""); err != nil || !json.Valid(page.Data) {
					t.Fatal("中止历史不可读", err)
				}
			}
			r.Wait(t, ends[0])
			if scenario == "restore_load_only" {
				before := a.Snapshot()
				a.Close()
				c.Restore = true
				a = New(c)
				defer a.Close()
				mustStart(t, a)
				successful(t, awaitOutput(t, a))
				if after := a.Snapshot(); after.ThreadID != before.ThreadID || after.TurnID != before.TurnID {
					t.Fatal("恢复改变原生身份")
				}
				if page, err := a.ReadHistory(ctx, ""); err != nil || !json.Valid(page.Data) {
					t.Fatal("恢复历史不可读", err)
				}
				r.Wait(t, ends[1])
			}
			if scenario == "symlinked_workspace" {
				a.Close()
				if err := os.Remove(r.Alias); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(t.TempDir(), r.Alias); err != nil {
					t.Fatal(err)
				}
				c.Restore = true
				b := New(c)
				defer b.Close()
				if err := b.Start(ctx); !errors.Is(err, ErrHistoryMissing) {
					t.Fatal("符号链接重定向被接受", err)
				}
			}
		})
	}
	if _, err := os.Stat("testdata/replay/interrupt_before_turn_started.ndjson"); os.IsNotExist(err) {
		t.Run("interrupt_before_turn_started", func(t *testing.T) { t.Skip("PS-178 尚未合入真实转录") })
	}
	t.Run("result_free_text", func(t *testing.T) {
		t.Skip("Codex 固定 outputSchema；自由文本由派生回放与结果校验覆盖")
	})
}

func TestRecordedCodexFaults(t *testing.T) {
	binary := replaytest.Build(t, "../../../tools/agent-replay")
	for _, name := range []string{"exit_mid_turn", "disconnect", "drop_settled", "quota", "free_text", "wrongversion", "badturn", "badsteer"} {
		t.Run(name, func(t *testing.T) {
			source := "simple"
			if name == "badsteer" {
				source = "deliver_active"
			}
			tape := replaytest.AdapterTape(replaytest.Load(t, "testdata/replay/"+source+".ndjson"))
			var err error
			switch name {
			case "exit_mid_turn":
				tape, err = tape.CutAfter("response:turn/start")
			case "disconnect":
				tape, err = tape.CutAfter("request:turn/start")
			case "drop_settled":
				tape, err = tape.Drop("event:turn/completed")
			case "wrongversion":
				tape = replaytest.Replace(t, tape, "event:frame:2", map[string]string{"text": "codex-cli 0.0.0"})
			case "badturn":
				f := replaytest.Frame(t, tape, "response:turn/start")
				f["result"].(map[string]any)["turn"].(map[string]any)["id"] = ""
				tape = replaytest.Replace(t, tape, "response:turn/start", f)
			case "badsteer":
				f := replaytest.Frame(t, tape, "response:turn/steer")
				f["result"].(map[string]any)["turnId"] = "another-turn"
				tape = replaytest.Replace(t, tape, "response:turn/steer", f)
				tape, err = tape.CutAfter("response:turn/steer")
			case "quota":
				// 配额故障无法稳定按需录制，沿用真实 failed 回合的形状替换完成事件。
				f := replaytest.Frame(t, tape, "event:turn/completed")
				turn := f["params"].(map[string]any)["turn"].(map[string]any)
				turn["status"] = "failed"
				turn["items"] = []any{}
				turn["error"] = map[string]any{"message": "quota exceeded"}
				tape = replaytest.Replace(t, tape, "event:turn/completed", f)
			case "free_text":
				// outputSchema 不能关闭，以派生最终消息验证 Worker 的自由文本拒绝。
				for _, e := range tape.Entries {
					if e.Type != "emit_inbound" {
						continue
					}
					f := replaytest.Frame(t, tape, e.Label)
					if p, ok := f["params"].(map[string]any); ok {
						if item, ok := p["item"].(map[string]any); ok && item["type"] == "agentMessage" {
							item["text"] = "自由文本"
						}
						if turn, ok := p["turn"].(map[string]any); ok {
							for _, v := range turn["items"].([]any) {
								item := v.(map[string]any)
								if item["type"] == "agentMessage" {
									item["text"] = "自由文本"
								}
							}
						}
						tape = replaytest.Replace(t, tape, e.Label, f)
					}
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			crash := ""
			if name != "disconnect" {
				tape, crash = replaytest.CrashGate(tape)
			}
			tape, ends := replaytest.EndGates(tape)
			gates := append([]string{}, ends...)
			if crash != "" {
				gates = append(gates, crash)
			}
			if name == "drop_settled" {
				gates = append(gates, ends[0])
			}
			r := replaytest.Prepare(t, binary, tape, gates...)
			c := replayConfig(r)
			a := New(c)
			defer a.Close()
			if name == "wrongversion" {
				if err := a.Start(context.Background()); !errors.Is(err, ErrIncompatible) {
					t.Fatal(err)
				}
				return
			}
			mustStart(t, a)
			_, inputErr := a.SubmitInput(context.Background(), `{"description":"任务","generation":1}`)
			if name == "disconnect" || name == "badturn" {
				if inputErr == nil {
					t.Fatal("无效输入响应被接受")
				}
				if err := a.StartTask(context.Background(), "execution-runtime:1", "重试"); !errors.Is(err, ErrUncertain) {
					t.Fatal(err)
				}
				return
			}
			if inputErr != nil {
				t.Fatal(inputErr)
			}
			if name == "exit_mid_turn" {
				r.Wait(t, crash)
				r.Release(t, crash)
			}
			if name == "badsteer" {
				_, _ = a.HistoryContains("delivery-runtime", false)
				f := replaytest.Frame(t, tape, "request:turn/steer")
				text := f["params"].(map[string]any)["input"].([]any)[0].(map[string]any)["text"].(string)
				text = strings.ReplaceAll(text, "<$delivery_id_1>", "delivery-runtime")
				if _, err := a.DeliverResult(context.Background(), "delivery-runtime", text); !errors.Is(err, ErrIncompatible) {
					t.Fatal(err)
				}
				r.Wait(t, crash)
				r.Release(t, crash)
				if err := a.SendInput(context.Background(), "delivery-runtime", "重试"); !errors.Is(err, ErrUncertain) {
					t.Fatal(err)
				}
				return
			}
			if name == "drop_settled" {
				r.Wait(t, ends[0])
				for _, out := range a.Drain() {
					if out.Exited || out.Final != "" {
						t.Fatalf("缺少 settled 被判停止: %+v", out)
					}
				}
				if stopped, _ := a.StopStatus(); stopped {
					t.Fatal("缺少 settled 的停止证据")
				}
				return
			}
			out := awaitOutput(t, a)
			if name == "free_text" {
				if _, err := task.ParseCandidate(out.Final); err == nil {
					t.Fatal("自由文本成为成功结果")
				}
			} else if !out.Uncertain {
				t.Fatalf("故障成为成功结果: %+v", out)
			}
		})
	}
}
