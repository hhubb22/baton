package session

import (
	"baton/internal/agent"
	"baton/internal/agent/kiro"
	"baton/internal/agent/replay"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"path/filepath"
	"testing"
	"time"

	"baton/internal/agent/kiro/kiroreplaytest"
	"baton/internal/protocol"
	"baton/internal/startpermit"
	"baton/internal/task"
)

func TestKiroWorkerRecorded(t *testing.T) {
	binary := kiroreplaytest.Build(t, "../../tools/agent-replay")
	for _, tape := range kiroreplaytest.Cases(t, "../agent/kiro/testdata/replay") {
		name := tape.Header.Scenario
		t.Run(name, func(t *testing.T) {
			w := &kiroReplayWorker{t: t, data: t.TempDir(), sid: mustSessionID(t), tid: mustSessionID(t), eid: mustSessionID(t)}
			d := protocol.ChildDelivery{DeliveryID: mustSessionID(t), TaskID: w.tid, ExecutionID: w.eid, SessionID: w.sid, ChildTaskID: mustSessionID(t), Result: json.RawMessage(`{"status":"completed","summary":"child-ok"}`)}
			if name == "deliver_idle" {
				tape = kiroDeliveryTape(t, tape, d)
			}
			if name == "restore_recall" {
				for i, e := range tape.Entries {
					if e.Label == "request:session/prompt:2" {
						tape.Entries = tape.Entries[:i]
						break
					}
				}
			}

			var ends []string
			tape, ends = kiroreplaytest.EndGates(tape)
			gates := append([]string{}, ends...)
			if name == "simple" {
				gates = append(gates, "response:session/prompt")
			}
			if name == "delegation" {
				gates = append(gates, "response:session/prompt", "response:session/load")
			}
			if name == "interrupt_mid_tool" || name == "supplement_active" {
				gates = append(gates, "notification:session/cancel")
			}
			if name == "interrupt_mid_tool" || name == "interrupt_before_turn_started" {
				gates = append(gates, "response:session/prompt")
			}
			r := kiroreplaytest.Prepare(t, binary, tape, gates...)
			t.Setenv("BATON_AGENT_DRIVER", "native")
			t.Setenv("BATON_TEST_EXECUTOR_LOG", "")
			t.Setenv("BATON_KIRO_BINARY", r.Binary)
			t.Setenv("BATON_KIRO_MODEL", tape.Header.Model)
			t.Setenv("BATON_KIRO_HOME", r.Home)
			w.fixture = r
			if _, err := EnsureToken(w.data, w.sid); err != nil {
				t.Fatal(err)
			}
			w.path, _ = LedgerPath(w.data, w.sid)
			if err := CreateLedger(w.path); err != nil {
				t.Fatal(err)
			}
			if name == "restore_missing" {
				c := agent.Config{Binary: r.Binary, Home: r.Home, Directory: r.Work, SessionDir: filepath.Join(r.Work, "native"), StatePath: filepath.Join(r.Work, "native", "state.json"), Model: tape.Header.Model, SessionID: w.sid, ExecutionID: w.eid}
				a := kiro.New(c)
				if err := a.Start(context.Background()); err != nil {
					t.Fatal(err)
				}
				r.Wait(t, ends[0])
				a.Close()
				state := a.Snapshot()
				state.NativeID = "native-session-2"
				raw, _ := json.Marshal(state)
				if err := os.WriteFile(c.StatePath, raw, 0600); err != nil {
					t.Fatal(err)
				}
				db, err := openWorkerDB(w.path, NewObserver(""))
				if err != nil {
					t.Fatal(err)
				}
				raw, _ = json.Marshal(c)
				for k, v := range map[string]string{"task_id": w.tid, "execution_id": w.eid, "agent_type": "kiro", "adapter_config": string(raw), "start_intent": "1", "input_submitted": "1", "input_generation": "1"} {
					if _, err := db.db.Exec(`INSERT INTO meta(key,value) VALUES(?,?)`, k, v); err != nil {
						t.Fatal(err)
					}
				}
				db.Close()
				w.launch()
				defer w.stop()
				result := w.report(protocol.ReportNeedsVerification, func(r protocol.ExecutionReport) bool { return true })
				if result.AgentStopped || result.Status != task.StatusNeedsVerification {
					t.Fatal("缺失历史被当作恢复")
				}
				w.input(`{"description":"禁止重发"}`)
				return
			}
			w.launch()
			defer func() { w.stop() }()
			w.authorize()
			payload, _ := task.MarshalExecutorInput("回放任务", nil, nil, &r.Alias, nil, 1, nil)
			w.input(string(payload))
			w.input(string(payload))
			if name == "supplement_active" {
				r.Wait(t, "notification:session/cancel")
				r.Release(t, "notification:session/cancel")
				req := protocol.SessionRequest{SessionID: w.sid, OperationID: mustSessionID(t), Action: "input", Text: "补充说明"}
				for i := 0; i < 2; i++ {
					status, err := w.client.SessionRequest(req)
					if err != nil || status.SessionResult == nil || !status.SessionResult.OK {
						t.Fatal("活动补充输入或重复查询失败", err, status.SessionResult)
					}
				}
			}
			if name == "interrupt_mid_tool" || name == "interrupt_before_turn_started" {
				if name == "interrupt_mid_tool" {
					r.Wait(t, "notification:session/cancel")
					r.Release(t, "notification:session/cancel")
				}
				if _, err := w.client.Stop(task.StatusCancelled); err != nil {
					t.Fatal(err)
				}
				early := w.report(task.EventStopReport, func(r protocol.ExecutionReport) bool { return !r.AgentStopped })
				if early.OutcomeKnown {
					t.Fatal("cancel 被当作副作用已知")
				}
				r.Wait(t, "response:session/prompt")
				r.Release(t, "response:session/prompt")
				_ = w.report(task.EventStopReport, func(r protocol.ExecutionReport) bool { return r.AgentStopped })
			} else if name == "delegation" {
				r.Wait(t, "response:session/prompt")
				d.DeliveryID = kiroreplaytest.QueriedDelivery(t, tape)
				if _, err := w.client.ReceiveChild(d, true); err != nil {
					t.Fatal(err)
				}
				r.Wait(t, "response:session/load")
				r.Release(t, "response:session/prompt")
				for _, report := range w.pending().Reports {
					if report.Kind == protocol.ReportResult {
						t.Fatal("持久历史响应前完成任务")
					}
				}
				r.Release(t, "response:session/load")
				_ = w.report(protocol.ReportResult, func(r protocol.ExecutionReport) bool {
					return r.Status == task.StatusCompleted && r.InputGeneration == 2
				})
				waitKiroWorker(t, func() bool {
					for _, receipt := range w.pending().ChildReceipts {
						if receipt.DeliveryID == d.DeliveryID && receipt.Status == "delivered" {
							return true
						}
					}
					return false
				})
				if _, err := w.client.ReceiveChild(d, true); err != nil {
					t.Fatal(err)
				}
			} else if name == "deliver_idle" {
				waitKiroWorker(t, func() bool {
					db, err := openReadLedger(w.path)
					if err != nil {
						t.Fatal(err)
					}
					defer db.Close()
					var waiting string
					_ = db.QueryRow(`SELECT value FROM meta WHERE key='waiting_children'`).Scan(&waiting)
					return waiting == "1"
				})
				if _, err := w.client.ReceiveChild(d, false); err != nil {
					r.Check(t)
					t.Fatal(err)
				}
				_ = w.report(protocol.ReportResult, func(r protocol.ExecutionReport) bool { return r.Status == task.StatusCompleted })
				waitKiroWorker(t, func() bool {
					for _, receipt := range w.pending().ChildReceipts {
						if receipt.DeliveryID == d.DeliveryID && receipt.Status == "delivered" && receipt.Generation == 2 {
							return true
						}
					}
					return false
				})
				if _, err := w.client.ReceiveChild(d, false); err != nil {
					t.Fatal(err)
				}
			} else {
				if name == "simple" {
					r.Wait(t, "response:session/prompt")
					for _, report := range w.pending().Reports {
						if report.Kind == protocol.ReportResult {
							t.Fatal("prompt 响应前完成任务")
						}
					}
					r.Release(t, "response:session/prompt")
				}
				result := w.report(protocol.ReportResult, func(r protocol.ExecutionReport) bool { return true })
				if name == "crash_after_prompt" || name == "missing_prompt_response" {
					if result.Status != task.StatusNeedsVerification || result.AgentStopped {
						t.Fatal("崩溃提供错误终态或停止事实")
					}
				}
				if name == "result_free_text" || name == "provider_error" || name == "crash_after_prompt" || name == "missing_prompt_response" {
					if result.Status == task.StatusCompleted {
						t.Fatal("错误输出成为成功")
					}
				} else if result.Status != task.StatusCompleted {
					t.Fatal(result.Status)
				}
				if name == "restore_load_only" || name == "restore_recall" {
					r.Wait(t, ends[0])
					w.stop()
					if name == "restore_load_only" {
						h := Host{DataDir: w.data}
						result, handled := h.storedHistory(context.Background(), protocol.SessionRequest{SessionID: w.sid, OperationID: mustSessionID(t), Action: "history", Limit: 16})
						if !handled || !result.OK || result.History == nil || len(result.History.Entries) == 0 {
							t.Fatal("Worker 退出后历史不可读", result.Code)
						}
						return
					}
					w.launch()
					// Worker 恢复保留原结果，不发送录制中由员工显式发起的 recall 输入。

				}
			}
			for _, end := range ends {
				r.Wait(t, end)
			}
		})
	}
}

type kiroReplayWorker struct {
	t                         *testing.T
	fixture                   *kiroreplaytest.Run
	data, sid, tid, eid, path string
	client                    *Client
	stop                      func()
}

// Worker 只自动续接明确等待子任务的来源；将真实 completed 派生为等待标记，
// 交付信封换成本轮账本身份，历史 user 输入保持与出站信封一致。
func kiroDeliveryTape(t *testing.T, tape replay.Transcript, d protocol.ChildDelivery) replay.Transcript {
	t.Helper()
	payload, _ := json.Marshal(d)
	text := strings.ReplaceAll(string(payload), d.DeliveryID, "<$delivery_id_1>")
	before := true
	waiting := false
	for i, e := range tape.Entries {
		if e.Label == "response:session/prompt" {
			before = false
		}
		if len(e.Frame) == 0 {
			continue
		}
		var f map[string]any
		_ = json.Unmarshal(e.Frame, &f)
		p, _ := f["params"].(map[string]any)
		if p == nil {
			continue
		}
		if e.Label == "request:session/prompt:2" {
			p["prompt"].([]any)[0].(map[string]any)["text"] = text
		}
		if u, ok := p["update"].(map[string]any); ok {
			if c, ok := u["content"].(map[string]any); ok {
				if before && u["sessionUpdate"] == "agent_message_chunk" {
					c["text"] = ""
					if !waiting {
						c["text"] = `{"baton_waiting_for_children":true}`
						waiting = true
					}
				}
				if u["sessionUpdate"] == "user_message_chunk" && strings.Contains(fmt.Sprint(c["text"]), "<$delivery_id_1>") {
					c["text"] = text
				}
			}
		}
		tape.Entries[i].Frame, _ = json.Marshal(f)
	}
	return tape
}

func (w *kiroReplayWorker) launch() {
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

func (w *kiroReplayWorker) authorize() {
	t := w.t
	c := w.client
	if _, err := c.Bind(w.tid, w.eid, "kiro"); err != nil {
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

func (w *kiroReplayWorker) pending() Status {
	w.t.Helper()
	st, err := w.client.Pending()
	if err != nil {
		w.fixture.Check(w.t)
		w.t.Fatal(err)
	}
	return st
}

func (w *kiroReplayWorker) report(kind string, predicate func(protocol.ExecutionReport) bool) protocol.ExecutionReport {
	w.t.Helper()
	var found protocol.ExecutionReport
	waitKiroWorker(w.t, func() bool {
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

func waitKiroWorker(t *testing.T, fn func() bool) {
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

func (w *kiroReplayWorker) input(payload string) {
	w.t.Helper()
	if _, err := w.client.SubmitInput(payload); err != nil {
		w.fixture.Check(w.t)
		w.t.Fatal(err)
	}
}
