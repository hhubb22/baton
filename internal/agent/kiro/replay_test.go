package kiro_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/kiro"
	"baton/internal/agent/kiro/kiroreplaytest"
	"baton/internal/protocol"
	"baton/internal/task"
)

func TestRecordedKiro(t *testing.T) {
	binary := kiroreplaytest.Build(t, "../../../tools/agent-replay")
	for _, tape := range kiroreplaytest.Cases(t, "testdata/replay") {
		t.Run(tape.Header.Scenario, func(t *testing.T) {
			tape, ends := kiroreplaytest.EndGates(tape)
			gates := append([]string{}, ends...)
			if tape.Header.Scenario == "simple" {
				gates = append(gates, "response:session/prompt")
			}
			if tape.Header.Scenario == "interrupt_mid_tool" || tape.Header.Scenario == "supplement_active" {
				gates = append(gates, "notification:session/cancel")
			}
			r := kiroreplaytest.Prepare(t, binary, tape, gates...)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			c := agent.Config{Binary: r.Binary, Home: r.Home, Directory: r.Alias, SessionDir: filepath.Join(r.Work, "native"), StatePath: filepath.Join(r.Work, "native", "state.json"), Model: tape.Header.Model, SessionID: "replay-session", ExecutionID: "replay-execution"}
			a := kiro.New(c)
			defer a.Close()
			if err := a.Start(ctx); err != nil {
				if tape.Header.Scenario == "provider_error" {
					return
				}
				t.Fatal(err)
			}
			if tape.Header.Scenario == "restore_missing" {
				s := a.Snapshot()
				s.NativeID = "native-session-2"
				raw, _ := json.Marshal(s)
				if err := os.WriteFile(c.StatePath, raw, 0600); err != nil {
					t.Fatal(err)
				}
				r.Wait(t, ends[0])
				a.Close()
				c.Restore = true
				b := kiro.New(c)
				defer b.Close()
				if err := b.Start(ctx); err == nil {
					t.Fatal("恢复了缺失会话")
				}
				return
			}
			if _, err := a.SubmitInput(ctx, `{"description":"回放","generation":1}`); err != nil {
				t.Fatal(err)
			}
			if tape.Header.Scenario == "supplement_active" {
				r.Wait(t, "notification:session/cancel")
				r.Release(t, "notification:session/cancel")
				if err := a.Supplement(ctx, "supplement", "补充说明"); err != nil {
					t.Fatal(err)
				}
			}
			switch tape.Header.Scenario {
			case "interrupt_mid_tool", "interrupt_before_turn_started":
				if tape.Header.Scenario == "interrupt_mid_tool" {
					r.Wait(t, "notification:session/cancel")
					r.Release(t, "notification:session/cancel")
				}
				if _, _, err := a.Abort(); err != nil {
					t.Fatal(err)
				}
			}
			if tape.Header.Scenario == "simple" {
				r.Wait(t, "response:session/prompt")
				if out := a.Drain(); len(out) != 0 {
					t.Fatal("prompt 响应前发布结果")
				}
				r.Release(t, "response:session/prompt")
			}
			out := terminal(t, ctx, a)
			if tape.Header.Scenario == "crash_after_prompt" || tape.Header.Scenario == "missing_prompt_response" {
				if !out.Uncertain || out.Final != "" {
					t.Fatal("崩溃被当作完成")
				}
				if stopped, _ := a.StopStatus(); stopped {
					t.Fatal("退出被当作停止")
				}
				return
			}
			if tape.Header.Scenario == "simple" || tape.Header.Scenario == "symlinked_workspace" {
				candidate, err := task.ParseCandidate(out.Final)
				if err != nil || candidate.Status != task.StatusCompleted || !out.Exited {
					t.Fatal("未结算完成", out, err)
				}
			}
			switch tape.Header.Scenario {
			case "interrupt_idle":
				if stopped, _, err := a.Abort(); err != nil || !stopped {
					t.Fatal(err)
				}
			case "deliver_idle":
				payload := `{"delivery_id":"kiro-real-delivery","result":{"status":"completed","summary":"child-ok"},"instruction":"Return completed JSON with summary baton-kiro-delivery-ok"}`
				if _, err := a.DeliverResult(ctx, "kiro-real-delivery", payload); err != nil {
					t.Fatal(err)
				}
				_ = terminal(t, ctx, a)
				if found, err := a.HistoryContains("kiro-real-delivery", false); err != nil || !found {
					t.Fatal("未确认 delivery_id", err)
				}
			case "restore_load_only", "restore_recall":
				r.Wait(t, ends[0])
				a.Close()
				c.Restore = true
				b := kiro.New(c)
				defer b.Close()
				if tape.Header.Scenario == "restore_load_only" {
					page, err := b.ReadBrowserHistory(ctx, "", 16)
					if err != nil || !protocol.ValidHistoryPage(&page) || len(page.Entries) == 0 {
						t.Fatal("Worker 退出后的原生历史不可读", err)
					}
					return
				}
				if err := b.Start(ctx); err != nil {
					t.Fatal(err)
				}
				if tape.Header.Scenario == "restore_recall" {
					if err := b.Supplement(ctx, "recall", "回忆"); err != nil {
						t.Fatal(err)
					}
					_ = terminal(t, ctx, b)
				}
			}
			for _, end := range ends {
				r.Wait(t, end)
			}
		})
	}
}

func terminal(t *testing.T, ctx context.Context, a *kiro.Adapter) agent.Output {
	t.Helper()
	for {
		for _, out := range a.Drain() {
			if out.Final != "" && !out.Exited {
				t.Fatal("提前发布结果")
			}
			if out.Exited || out.Uncertain || out.WaitingForChildren {
				return out
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("等待结算超时")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestSupplementInvalidatesQueuedOldResult(t *testing.T) {
	binary := kiroreplaytest.Build(t, "../../../tools/agent-replay")
	tape := kiroreplaytest.Load(t, "testdata/replay/deliver_idle.ndjson")
	tape, ends := kiroreplaytest.EndGates(tape)
	r := kiroreplaytest.Prepare(t, binary, tape, ends...)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c := agent.Config{Binary: r.Binary, Home: r.Home, Directory: r.Work, SessionDir: filepath.Join(r.Work, "native"), StatePath: filepath.Join(r.Work, "native", "state.json"), Model: tape.Header.Model, SessionID: "queued-result", ExecutionID: "queued-execution"}
	a := kiro.New(c)
	defer a.Close()
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := a.SubmitInput(ctx, `{"description":"回放","generation":1}`); err != nil {
		t.Fatal(err)
	}
	for a.Snapshot().Pending {
		select {
		case <-ctx.Done():
			t.Fatal("旧回合没有结束")
		case <-time.After(time.Millisecond):
		}
	}
	// 保留旧 Final 在 Drain 队列中，再模拟 Worker 前置 poll 后到达的补充输入。
	payload := `{"delivery_id":"new-delivery","result":{"status":"completed","summary":"child-ok"},"instruction":"Return completed JSON with summary baton-kiro-delivery-ok"}`
	if err := a.Supplement(ctx, "supplement", payload); err != nil {
		t.Fatal(err)
	}
	out := terminal(t, ctx, a)
	candidate, err := task.ParseCandidate(out.Final)
	if err != nil || candidate.Summary != "baton-kiro-delivery-ok" {
		t.Fatal("旧结果完成了新输入", err)
	}
	r.Wait(t, ends[0])
}
