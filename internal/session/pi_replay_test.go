package session

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/pi"
	"baton/internal/agent/pi/pireplaytest"
	"baton/internal/protocol"
	"baton/internal/startpermit"
	"baton/internal/task"
)

type piReplayWorker struct {
	t                         *testing.T
	fixture                   *pireplaytest.Fixture
	data, sid, tid, eid, path string
	client                    *Client
	stop                      func()
}

func (w *piReplayWorker) launch() {
	t := w.t
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- RunWorker(ctx, w.data, w.sid) }()
	endpoint, _ := Endpoint(w.data, w.sid)
	token, _ := readToken(w.data, w.sid)
	w.client = waitClient(t, endpoint, token)
	_ = w.client.conn.SetDeadline(time.Time{})
	stopped := false
	w.stop = func() {
		if stopped {
			return
		}
		stopped = true
		_ = w.client.Close()
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(10 * time.Second):
			t.Error("Worker 未退出")
		}
	}
	t.Cleanup(w.stop)
}

func (w *piReplayWorker) authorize() {
	t := w.t
	c := w.client
	if _, err := c.Bind(w.tid, w.eid, "pi"); err != nil {
		t.Fatal(err)
	}
	nonce := armNonce(t, c, w.tid, w.eid)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	generation := mustSessionID(t)
	queue := time.Now().UTC().Add(time.Minute).Truncate(time.Millisecond)
	permit := signPermit(t, priv, w.tid, w.eid, generation, nonce, queue, startpermit.PermitTTL)
	if _, err := c.Authorize(w.tid, w.eid, permit, base64.RawURLEncoding.EncodeToString(pub), generation, queue.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
}

func (w *piReplayWorker) pending() Status {
	w.t.Helper()
	st, err := w.client.Pending()
	if err != nil {
		w.fixture.Check(w.t)
		w.t.Fatal(err)
	}
	return st
}

func (w *piReplayWorker) report(kind string, predicate func(protocol.ExecutionReport) bool) protocol.ExecutionReport {
	w.t.Helper()
	var found protocol.ExecutionReport
	waitPiWorker(w.t, func() bool {
		for _, r := range w.pending().Reports {
			if r.Kind == kind {
				var body protocol.ExecutionReport
				if err := json.Unmarshal(r.Body, &body); err != nil {
					w.t.Fatal(err)
				}
				if predicate(body) {
					found = body
					return true
				}
			}
		}
		return false
	})
	return found
}

func waitPiWorker(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("等待 Worker 事实超时")
}

func (w *piReplayWorker) input(payload string) {
	w.t.Helper()
	if _, err := w.client.SubmitInput(payload); err != nil {
		w.fixture.Check(w.t)
		w.t.Fatal(err)
	}
}

func TestPiWorkerRecordedTranscripts(t *testing.T) {
	binary := pireplaytest.Build(t, "../../tools/agent-replay")
	names := append(append([]string{}, pireplaytest.Scenarios...), pireplaytest.Variants...)
	names = append(names, "delivery_history_missing")
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			if name == "startup" {
				t.Skip("独立无输入探针；Worker 只在提交任务时初始化 Agent，适配器层完整回放此转录")
			}
			base := name
			if name == "delivery_history_missing" {
				base = "deliver_idle"
			}
			tape := pireplaytest.Tape(t, "../agent/pi/testdata/replay", base)
			if base == "deliver_idle" {
				tape = pireplaytest.BeforeDeliveryHistory(tape)
			}
			if name == "restore_recall" {
				// Worker 的新执行会重开适配器；恢复阶段以最后一条初始化响应为界。
				var err error
				tape, err = tape.CutAfter("response:get_state:2")
				if err != nil {
					t.Fatal(err)
				}
			}
			if name == "interrupt_idle" {
				// Worker 对已经落账的结果直接报告停止事实，不再向空闲 Agent 发 abort。
				var err error
				tape, err = tape.CutAfter("event:agent_settled")
				if err != nil {
					t.Fatal(err)
				}
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
			case "delivery_history_missing":
				gates = append(gates, "response:prompt:2", "event:agent_settled:2")
			}
			data := pireplaytest.Canonical(t, t.TempDir())
			sid := mustSessionID(t)
			f := pireplaytest.New(t, binary, tape, data, sid, t.TempDir(), gates...)
			w := &piReplayWorker{t: t, fixture: f, data: data, sid: sid, tid: mustSessionID(t), eid: mustSessionID(t)}
			// 直接适配器录制的 probe/native 等目录也由绑定提供；Worker 仍使用真实 Pi Adapter。
			registration := registeredAdapters["pi"]
			saved := registration
			registration.new = func(c agent.Config) agent.Adapter { c.SessionDir = f.Agent.SessionDir; return pi.New(c) }
			registeredAdapters["pi"] = registration
			t.Cleanup(func() { registeredAdapters["pi"] = saved })
			t.Setenv("BATON_AGENT_DRIVER", "native")
			t.Setenv("BATON_TEST_EXECUTOR_LOG", "")
			t.Setenv("BATON_PI_BIN", f.Binary)
			t.Setenv("BATON_PI_MODEL", f.Agent.Model)
			t.Setenv("BATON_PI_HOME", f.Agent.Home)
			if _, err := EnsureToken(data, sid); err != nil {
				t.Fatal(err)
			}
			w.path, _ = LedgerPath(data, sid)
			if err := CreateLedger(w.path); err != nil {
				t.Fatal(err)
			}
			if base == "deliver_idle" {
				// 任务及子结果身份取自录制信封；Session 与 delivery_id 仍由本次运行捕获。
				for _, e := range tape.Entries {
					if e.Label == "request:prompt:2" {
						var frame struct{ Message string }
						_ = json.Unmarshal(e.Frame, &frame)
						var d protocol.ChildDelivery
						_ = json.Unmarshal([]byte(frame.Message), &d)
						w.tid, w.eid = d.TaskID, d.ExecutionID
					}
				}
			}
			if name == "restore_missing" {
				// 录制在无输入初始化后尝试恢复。准备同一原生映射，再让 RunWorker 处理输入意图后的缺失历史。
				a := pi.New(f.Agent)
				if err := a.Start(context.Background()); err != nil {
					t.Fatal(err)
				}
				f.Wait(t, pireplaytest.LastExit(tape, 2))
				f.Release(t, pireplaytest.LastExit(tape, 2))
				_ = a.Close()
				config := f.Agent
				config.ExecutionID = w.eid
				raw, _ := json.Marshal(config)
				db, err := openWorkerDB(w.path, NewObserver(""))
				if err != nil {
					t.Fatal(err)
				}
				for k, v := range map[string]string{"task_id": w.tid, "execution_id": w.eid, "agent_type": "pi", "adapter_config": string(raw), "start_intent": "1", "input_submitted": "1", "input_generation": "1"} {
					if _, err := db.db.Exec(`INSERT INTO meta(key,value) VALUES(?,?)`, k, v); err != nil {
						t.Fatal(err)
					}
				}
				_ = db.Close()
				w.launch()
				r := w.report(protocol.ReportNeedsVerification, func(r protocol.ExecutionReport) bool { return r.Status == task.StatusNeedsVerification })
				if r.ErrorCode != task.CodeUncertainHistory || r.AgentStopped {
					t.Fatalf("缺失历史: %+v", r)
				}
				w.input(`{"description":"禁止恢复重发"}`)
				w.stop()
				return
			}
			w.launch()
			defer func() {
				for _, l := range gates {
					f.Release(t, l)
				}
				w.stop()
				f.Check(t)
			}()
			w.authorize()
			payload, _ := task.MarshalExecutorInput("录制回放任务", nil, nil, &f.Agent.Directory, nil, 1, nil)
			w.input(string(payload))
			w.input(string(payload))
			switch name {
			case "interrupt_mid_tool", "abort_missing_settled":
				f.Wait(t, "event:tool_execution_start")
				f.Release(t, "event:tool_execution_start")
				if _, err := w.client.Stop(task.StatusCancelled); err != nil {
					t.Fatal(err)
				}
				first := w.report(task.EventStopReport, func(r protocol.ExecutionReport) bool { return !r.AgentStopped })
				if first.OutcomeKnown || first.Status != task.StatusNeedsVerification {
					t.Fatalf("中止 ACK 成为停止证据: %+v", first)
				}
				if name == "interrupt_mid_tool" {
					if _, err := w.client.Ack(first.EventID); err != nil {
						t.Fatal(err)
					}
					f.Wait(t, "event:agent_settled")
					f.Release(t, "event:agent_settled")
					late := w.report(task.EventStopReport, func(r protocol.ExecutionReport) bool { return r.AgentStopped })
					if late.OutcomeKnown || late.Status != task.StatusNeedsVerification || late.EventID == first.EventID {
						t.Fatalf("迟到停止事实: %+v", late)
					}
				}
			case "interrupt_before_turn_started":
				if _, err := w.client.Stop(task.StatusCancelled); err != nil {
					t.Fatal(err)
				}
				r := w.report(task.EventStopReport, func(r protocol.ExecutionReport) bool { return r.AgentStopped })
				if !r.OutcomeKnown || r.NotStarted {
					t.Fatalf("早到中止: %+v", r)
				}
				if _, _, err := w.client.NativeHistory(""); err != nil {
					t.Fatal("中止后历史缺失", err)
				}
			case "missing_settled":
				f.Wait(t, pireplaytest.LastExit(tape, 2))
				for _, r := range w.pending().Reports {
					if r.Kind == protocol.ReportResult {
						t.Fatal("settled 缺失却生成最终报告")
					}
				}
				f.Release(t, pireplaytest.LastExit(tape, 2))
				r := w.report(protocol.ReportResult, func(r protocol.ExecutionReport) bool { return r.Status == task.StatusNeedsVerification })
				if r.AgentStopped {
					t.Fatal("进程退出被当作已停止")
				}
			case "exit_mid_turn":
				r := w.report(protocol.ReportResult, func(r protocol.ExecutionReport) bool { return r.Status == task.StatusNeedsVerification })
				if r.AgentStopped {
					t.Fatal("崩溃被当作已停止")
				}
			case "deliver_idle", "delivery_history_missing":
				waitPiWorker(t, func() bool {
					db, err := openReadLedger(w.path)
					if err != nil {
						t.Fatal(err)
					}
					defer db.Close()
					var value string
					_ = db.QueryRow(`SELECT value FROM meta WHERE key='waiting_children'`).Scan(&value)
					return value == "1"
				})
				f.VersionProbe(t)
				var d protocol.ChildDelivery
				if err := json.Unmarshal([]byte(f.Delivery(t)), &d); err != nil {
					t.Fatal(err)
				}
				files, _ := filepath.Glob(filepath.Join(f.Agent.SessionDir, "*.jsonl"))
				if len(files) != 1 {
					t.Fatal(files)
				}
				original, err := os.ReadFile(files[0])
				if err != nil {
					t.Fatal(err)
				}
				delivered := make(chan error, 1)
				go func() { _, err := w.client.ReceiveChild(d, false); delivered <- err }()
				if name == "deliver_idle" {
					f.Wait(t, "history:delivery")
					assertPiDeliveryLedger(t, w.path, d.DeliveryID, "uncertain")
					f.Release(t, "history:delivery")
				} else {
					// 历史丢失是文件故障：保留 ACK，移除尚未被 Worker 确认的 user 交付记录。
					f.Wait(t, "response:prompt:2")
					if err := os.WriteFile(files[0], original, 0600); err != nil {
						t.Fatal(err)
					}
					f.Release(t, "response:prompt:2")
				}
				if err := <-delivered; err != nil {
					f.Check(t)
					t.Fatal(err)
				}
				if name == "delivery_history_missing" {
					f.Wait(t, "event:agent_settled:2")
					assertPiDeliveryLedger(t, w.path, d.DeliveryID, "uncertain")
					for _, r := range w.pending().ChildReceipts {
						if r.Status == "delivered" {
							t.Fatal("只有 ACK 却报告 delivered")
						}
					}
					f.Release(t, "event:agent_settled:2")
					w.report(protocol.ReportResult, func(r protocol.ExecutionReport) bool { return r.Status == task.StatusNeedsVerification })
				} else {
					w.report(protocol.ReportResult, func(r protocol.ExecutionReport) bool { return r.Status == task.StatusCompleted })
					waitPiWorker(t, func() bool {
						for _, r := range w.pending().ChildReceipts {
							if r.DeliveryID == d.DeliveryID && r.Status == "delivered" && r.Generation == 2 {
								return true
							}
						}
						return false
					})
				}
				if _, err := w.client.ReceiveChild(d, false); err != nil {
					t.Fatal(err)
				}
			default:
				if name == "simple" {
					f.Wait(t, "event:agent_settled")
					for _, r := range w.pending().Reports {
						if r.Kind == protocol.ReportResult {
							t.Fatal("settled 前生成报告")
						}
					}
					f.Release(t, "event:agent_settled")
				}
				expected := task.StatusCompleted
				if name == "result_free_text" {
					expected = task.StatusFailed
				}
				if name == "provider_error" || name == "quota_error" {
					expected = task.StatusNeedsVerification
				}
				result := w.report(protocol.ReportResult, func(r protocol.ExecutionReport) bool { return r.Status == expected })
				if result.TaskID != w.tid || result.ExecutionID != w.eid || result.SessionID != sid {
					t.Fatal("结果身份不匹配", result)
				}
				if name == "result_free_text" && result.ErrorCode != task.CodeResultFormat {
					t.Fatal(result)
				}
				if name == "interrupt_idle" {
					if _, err := w.client.Stop(task.StatusCancelled); err != nil {
						t.Fatal(err)
					}
					w.report(task.EventStopReport, func(r protocol.ExecutionReport) bool { return r.AgentStopped && r.OutcomeKnown })
				}
				if name == "restore_load_only" || name == "restore_recall" {
					for _, l := range gates {
						if l == pireplaytest.LastExit(tape, 2) {
							f.Release(t, l)
						}
					}
					w.stop()
					w.launch()
					replayed := w.report(protocol.ReportResult, func(r protocol.ExecutionReport) bool { return r.EventID == result.EventID })
					if replayed.Summary != result.Summary {
						t.Fatal("outbox 恢复改变原结果")
					}
					w.input(string(payload))
					if label := pireplaytest.LastExit(tape, 4); label != "" {
						f.Wait(t, label)
					}
				}
			}
			w.input(string(payload))
			if name == "delivery_history_missing" {
				var d protocol.ChildDelivery
				_ = json.Unmarshal([]byte(f.Delivery(t)), &d)
				assertPiDeliveryLedger(t, w.path, d.DeliveryID, "uncertain")
			}
			// 转录严格比较任务 prompt 数量；账本另行验证意图和原任务输入只保存一次。
			db, err := openReadLedger(w.path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			var inputs int
			if err := db.QueryRow(`SELECT COUNT(*) FROM execution_log WHERE kind='input' AND body=?`, string(payload)).Scan(&inputs); err != nil {
				t.Fatal(err)
			}
			want := 1
			if inputs != want {
				t.Fatalf("任务输入数=%d，期望 %d", inputs, want)
			}
		})
	}
}

func assertPiDeliveryLedger(t *testing.T, path, id, want string) {
	t.Helper()
	db, err := openReadLedger(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var status string
	if err := db.QueryRow(`SELECT status FROM child_deliveries WHERE delivery_id=?`, id).Scan(&status); err != nil || status != want {
		t.Fatalf("交付账本=%s，期望 %s: %v", status, want, err)
	}
}

func openReadLedger(path string) (*sql.DB, error) {
	u, err := url.Parse(sqliteDSN(path))
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("mode", "ro")
	u.RawQuery = q.Encode()
	return sql.Open("sqlite", u.String())
}
