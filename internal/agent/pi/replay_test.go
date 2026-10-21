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
	"baton/internal/task"
)

func TestPiRecordedTranscripts(t *testing.T) {
	files, err := filepath.Glob("testdata/replay/*.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != len(pireplaytest.Scenarios) {
		t.Fatalf("转录数=%d，场景数=%d", len(files), len(pireplaytest.Scenarios))
	}
	binary := pireplaytest.Build(t, "../../../tools/agent-replay")
	names := append(append([]string{}, pireplaytest.Scenarios...), pireplaytest.Variants...)
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			tape := pireplaytest.Tape(t, "testdata/replay", name)
			if name == "deliver_idle" {
				tape = pireplaytest.BeforeDeliveryHistory(tape)
			}
			gates := []string{}
			for _, e := range tape.Entries {
				if e.Type == "runtime_exit" && e.Process != 1 && e.Process != 3 && e.Label != "" {
					gates = append(gates, e.Label)
				}
			}
			switch name {
			case "simple":
				gates = append(gates, "event:agent_settled")
			case "interrupt_mid_tool":
				gates = append(gates, "event:tool_execution_start", "event:agent_settled")
			case "abort_missing_settled":
				gates = append(gates, "event:tool_execution_start")
			case "deliver_idle":
				gates = append(gates, "history:delivery")
			}
			f := pireplaytest.New(t, binary, tape, t.TempDir(), "11111111-1111-4111-8111-111111111111", t.TempDir(), gates...)
			a := New(f.Agent)
			defer func() {
				for _, label := range gates {
					f.Release(t, label)
				}
				_ = a.Close()
				f.Check(t)
			}()
			if err := a.Start(context.Background()); err != nil {
				f.Check(t)
				t.Fatal(err)
			}
			if a.cmd.Dir != f.Replay.Bindings["<workspace>"] {
				t.Fatalf("RPC 工作目录: %s", a.cmd.Dir)
			}

			if a.Model() == "" {
				t.Fatal("初始化没有报告模型")
			}
			switch name {
			case "startup":
				f.Wait(t, pireplaytest.LastExit(tape, 2))
				return
			case "restore_missing":
				f.Wait(t, pireplaytest.LastExit(tape, 2))
				f.Release(t, pireplaytest.LastExit(tape, 2))
				_ = a.Close()
				config := f.Agent
				config.Restore = true
				if err := New(config).Start(context.Background()); err != ErrHistoryMissing {
					t.Fatalf("缺失历史: %v", err)
				}
				if len(f.Captures(t)) != 3 {
					t.Fatalf("缺失历史启动了额外进程: %v", f.Captures(t))
				}
				return
			}
			if _, err := a.SubmitInput(context.Background(), `{"description":"录制回放任务"}`); err != nil {
				f.Check(t)
				t.Fatal(err)
			}
			switch name {
			case "interrupt_mid_tool", "abort_missing_settled":
				f.Wait(t, "event:tool_execution_start")
				if _, err := a.SubmitInput(context.Background(), "second"); err == nil {
					t.Fatal("接受了并发任务输入")
				}
				f.Release(t, "event:tool_execution_start")
				stopped, known, err := a.Abort()
				if err == nil || stopped || known {
					t.Fatalf("settled 到达前报告停止: %t %t %v", stopped, known, err)
				}
				if stopped, known := a.StopStatus(); stopped || known {
					t.Fatal("缺失 settled 却确认停止")
				}
				if name == "interrupt_mid_tool" {
					f.Wait(t, "event:agent_settled")
					f.Release(t, "event:agent_settled")
					waitPi(t, func() bool { stopped, known := a.StopStatus(); return stopped && !known })
					for range 3 {
						if stopped, known := a.StopStatus(); !stopped || known {
							t.Fatal("迟到的停止事实丢失")
						}
					}
				}
				if len(a.Drain()) != 0 {
					t.Fatal("中止回合产生普通结果")
				}
			case "interrupt_before_turn_started":
				stopped, known, err := a.Abort()
				if err != nil || !stopped || !known {
					f.Check(t)
					t.Fatalf("早到中止: %t %t %v", stopped, known, err)
				}
				if err := a.walkHistory(nil); err != nil {
					t.Fatal("中止后原生会话不可读", err)
				}
			case "missing_settled":
				f.Wait(t, pireplaytest.LastExit(tape, 2))
				if len(a.Drain()) != 0 {
					t.Fatal("agent_end 被当作 settled")
				}
				if s, k := a.StopStatus(); s || k {
					t.Fatal("缺少 settled 却报告停止")
				}
				// 释放录制的进程退出后仍只能得到不确定结果。
				f.Release(t, pireplaytest.LastExit(tape, 2))
				out := waitOutput(t, a)
				if !out.Uncertain || out.Exited {
					t.Fatalf("退出被当作结算: %+v", out)
				}
			case "exit_mid_turn":
				out := waitOutput(t, a)
				if !out.Uncertain || out.Exited {
					t.Fatalf("崩溃被当作结算: %+v", out)
				}
				return
			default:
				if name == "simple" {
					f.Wait(t, "event:agent_settled")
					if len(a.Drain()) != 0 {
						t.Fatal("settled 前返回最终结果")
					}
					if err := a.walkHistory(nil); err != nil {
						t.Fatal(err)
					}
					f.Release(t, "event:agent_settled")
				}
				out := waitOutput(t, a)
				switch name {
				case "result_free_text":
					if _, err := task.ParseCandidate(out.Final); err == nil {
						t.Fatal("自由文本变成结构化成功")
					}
				case "provider_error", "quota_error":
					if !out.Uncertain || !out.Exited {
						t.Fatalf("provider 错误被当作成功: %+v", out)
					}
				case "deliver_idle":
					if !out.WaitingForChildren || out.Exited || out.Uncertain {
						t.Fatalf("等待子任务: %+v", out)
					}
					// 录制还包含子任务启动时的 --version；不启动子模型或子 Worker。
					f.VersionProbe(t)
					payload := f.Delivery(t)
					var d struct {
						DeliveryID string `json:"delivery_id"`
					}
					_ = json.Unmarshal([]byte(payload), &d)
					if yes, err := a.HistoryContains(d.DeliveryID, false); err != nil || yes {
						t.Fatalf("交付前历史误报: %v %v", yes, err)
					}
					sent := make(chan error, 1)
					go func() { _, err := a.DeliverResult(context.Background(), d.DeliveryID, payload); sent <- err }()
					f.Wait(t, "history:delivery")
					if yes, err := a.HistoryContains(d.DeliveryID, false); err != nil || yes {
						t.Fatalf("未落盘却确认交付: %v %v", yes, err)
					}
					f.Release(t, "history:delivery")
					if err := <-sent; err != nil {
						f.Check(t)
						t.Fatal(err)
					}
					assertPiCompleted(t, waitOutput(t, a))
					if yes, err := a.HistoryContains(d.DeliveryID, false); err != nil || !yes {
						t.Fatalf("交付历史缺失: %v %v", yes, err)
					}
					if yes, err := a.HistoryContains(d.DeliveryID, true); err != nil || yes {
						t.Fatalf("用户输入被误认为工具查询: %v %v", yes, err)
					}
					if _, err := a.DeliverResult(context.Background(), d.DeliveryID, payload); err != nil {
						t.Fatal(err)
					}
					if len(a.Drain()) != 0 {
						t.Fatal("重复交付启动了新回合")
					}
				default:
					assertPiCompleted(t, out)
				}
				if name == "interrupt_idle" {
					stopped, known, err := a.Abort()
					if err != nil || !stopped || !known {
						t.Fatalf("空闲中止: %t %t %v", stopped, known, err)
					}
				}
				if name == "restore_load_only" || name == "restore_recall" {
					// 后续进程使用首次捕获的 Session ID，恢复只加载原历史。
					original := f.Captures(t)["<$session_id_1>"]
					f.Release(t, pireplaytest.LastExit(tape, 2))
					_ = a.Close()
					config := f.Agent
					config.Restore = true
					a = New(config)
					if err := a.Start(context.Background()); err != nil {
						f.Check(t)
						t.Fatal(err)
					}
					if f.Captures(t)["<$session_id_1>"] != original || len(a.Drain()) != 0 {
						t.Fatal("恢复替换了 Session 或重发输入")
					}
					if name == "restore_recall" {
						if _, err := a.SubmitInput(context.Background(), "显式询问原上下文"); err != nil {
							t.Fatal(err)
						}
						assertPiCompleted(t, waitOutput(t, a))
					}
					f.Wait(t, pireplaytest.LastExit(tape, 4))
					return
				}
			}
			f.Wait(t, pireplaytest.LastExit(tape, 2))
		})
	}
}

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

func waitOutput(t *testing.T, a *Adapter) agent.Output {
	t.Helper()
	var result agent.Output
	waitPi(t, func() bool {
		out := a.Drain()
		if len(out) == 0 {
			return false
		}
		if len(out) != 1 {
			t.Fatalf("重复结果: %+v", out)
		}
		result = out[0]
		return true
	})
	return result
}

func assertPiCompleted(t *testing.T, out agent.Output) {
	t.Helper()
	result, err := task.ParseCandidate(out.Final)
	if err != nil || result.Status != task.StatusCompleted || !out.Exited || out.Uncertain {
		t.Fatalf("结构化结果: %+v %v", out, err)
	}
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
			_, err = a.SubmitInput(context.Background(), "task")
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
		if e.Label == "event:agent_settled" && len(a.Drain()) != 0 {
			t.Fatal("结算前报告结果")
		}
		f.Release(t, e.Label)
	}
	if err := <-done; err != nil {
		f.Check(t)
		t.Fatal(err)
	}
	assertPiCompleted(t, waitOutput(t, a))
	f.Wait(t, pireplaytest.LastExit(tape, 2))
}
