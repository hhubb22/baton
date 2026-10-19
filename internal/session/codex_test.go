package session

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/codex"
	"baton/internal/agent/codex/replaytest"
	"baton/internal/agent/replay"
	"baton/internal/privatefile"
	"baton/internal/protocol"
	"baton/internal/startpermit"
	"baton/internal/task"
)

type codexWorkerRun struct {
	replay                    *replaytest.Run
	data, sid, tid, eid, path string
	c                         *Client
	stop                      func()
}

func newCodexWorkerRun(t *testing.T) *codexWorkerRun {
	t.Helper()
	w := &codexWorkerRun{data: t.TempDir(), sid: mustSessionID(t), tid: mustSessionID(t), eid: mustSessionID(t)}
	if _, err := EnsureToken(w.data, w.sid); err != nil {
		t.Fatal(err)
	}
	w.path, _ = LedgerPath(w.data, w.sid)
	if err := CreateLedger(w.path); err != nil {
		t.Fatal(err)
	}
	return w
}
func (w *codexWorkerRun) launch(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- RunWorker(ctx, w.data, w.sid) }()
	ep, _ := Endpoint(w.data, w.sid)
	token, _ := readToken(w.data, w.sid)
	w.c = waitClient(t, ep, token)
	stopped := false
	w.stop = func() {
		if stopped {
			return
		}
		stopped = true
		w.c.Close()
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(15 * time.Second):
			t.Error("Worker 未退出")
		}
	}
	t.Cleanup(w.stop)
}
func (w *codexWorkerRun) authorize(t *testing.T) {
	t.Helper()
	if _, err := w.c.Bind(w.tid, w.eid, "codex"); err != nil {
		t.Fatal(err)
	}
	nonce := armNonce(t, w.c, w.tid, w.eid)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	generation := mustSessionID(t)
	queue := time.Now().UTC().Add(time.Minute).Truncate(time.Millisecond)
	permit := signPermit(t, priv, w.tid, w.eid, generation, nonce, queue, startpermit.PermitTTL)
	if _, err := w.c.Authorize(w.tid, w.eid, permit, base64.RawURLEncoding.EncodeToString(pub), generation, queue.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
}
func (w *codexWorkerRun) report(t *testing.T, kind string, predicate func(protocol.ExecutionReport) bool) protocol.ExecutionReport {
	t.Helper()
	var found protocol.ExecutionReport
	t.Cleanup(func() {
		if t.Failed() {
			st, err := w.c.Pending()
			t.Logf("待交付报告: %+v %v", st.Reports, err)
			for _, r := range st.Reports {
				t.Logf("%s %s", r.Kind, r.Body)
			}
		}
	})
	waitCodexFact(t, func() bool {
		st, err := w.c.Pending()
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range st.Reports {
			if r.Kind == kind {
				var report protocol.ExecutionReport
				if err := json.Unmarshal(r.Body, &report); err != nil {
					t.Fatal(err)
				}
				if predicate(report) {
					found = report
					return true
				}
			}
		}
		return false
	})
	return found
}
func waitCodexFact(t *testing.T, f func() bool) {
	t.Helper()
	until := time.Now().Add(12 * time.Second)
	for time.Now().Before(until) {
		if f() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("等待 Worker 事实超时")
}
func (w *codexWorkerRun) db(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", sqliteDSN(w.path))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// WorkerTape 使用录制响应，选择 Worker 实际调用的只读查询，并将测试驱动的精简交付信封换成完整 Worker 信封。
func workerCodexTape(t *testing.T, tape replay.Transcript, delivery protocol.ChildDelivery, variant string) replay.Transcript {
	t.Helper()
	tape = replaytest.AdapterTape(tape)
	keep := map[string]bool{"request:thread/items/list:2": true, "request:thread/items/list:3": true, "request:thread/items/list:5": true}
	if tape.Header.Scenario == "delegation" {
		keep["request:thread/items/list"] = true
	}
	if variant == "delivery_wrong_id" {
		keep["request:thread/items/list:4"] = true
	}
	tape = replaytest.SelectReads(tape, keep)
	payload, _ := json.Marshal(delivery)
	for i, e := range tape.Entries {
		if e.Type != "expect_outbound" {
			continue
		}
		var f map[string]any
		_ = json.Unmarshal(e.Frame, &f)
		p, _ := f["params"].(map[string]any)
		if p == nil {
			continue
		}
		id, _ := p["clientUserMessageId"].(string)
		if id != "<$delivery_id_1>" {
			continue
		}
		p["input"].([]any)[0].(map[string]any)["text"] = strings.ReplaceAll(string(payload), delivery.DeliveryID, "<$delivery_id_1>")
		tape.Entries[i].Frame, _ = json.Marshal(f)
	}
	return tape
}

func TestRecordedCodexWorkerScenarios(t *testing.T) {
	binary := replaytest.Build(t, "../../tools/agent-replay")
	paths, err := filepath.Glob("../agent/codex/testdata/replay/*.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		t.Run(strings.TrimSuffix(filepath.Base(path), ".ndjson"), func(t *testing.T) { runRecordedCodexWorker(t, binary, path, "") })
	}
	for _, variant := range []string{"exit_mid_turn", "disconnect", "drop_settled", "free_text", "delivery_wrong_id"} {
		t.Run(variant, func(t *testing.T) {
			source := "simple"
			if variant == "delivery_wrong_id" {
				source = "deliver_active"
			}
			runRecordedCodexWorker(t, binary, "../agent/codex/testdata/replay/"+source+".ndjson", variant)
		})
	}
	if _, err := os.Stat("../agent/codex/testdata/replay/interrupt_before_turn_started.ndjson"); os.IsNotExist(err) {
		t.Run("interrupt_before_turn_started", func(t *testing.T) { t.Skip("PS-178 尚未合入真实转录") })
	}
}
func runRecordedCodexWorker(t *testing.T, binary, path, variant string) {
	w := newCodexWorkerRun(t)
	delivery := protocol.ChildDelivery{DeliveryID: mustSessionID(t), TaskID: w.tid, ExecutionID: w.eid, SessionID: w.sid, ChildTaskID: mustSessionID(t), Result: json.RawMessage(`{"status":"completed","summary":"子结果"}`)}
	source := replaytest.Load(t, path)
	if source.Header.Scenario == "delegation" {
		delivery.DeliveryID = replaytest.QueriedDelivery(t, source)
	}
	tape := workerCodexTape(t, source, delivery, variant)
	scenario := tape.Header.Scenario
	hasDelivery := scenario == "deliver_active" || scenario == "deliver_idle" || scenario == "restore_load_only"
	if scenario == "deliver_idle" {
		// 真实录制的第一回合返回 completed；派生为 Worker 允许自动续接的等待子结果标记。
		f := replaytest.Frame(t, tape, "event:turn/completed")
		turn := f["params"].(map[string]any)["turn"].(map[string]any)
		for _, v := range turn["items"].([]any) {
			item := v.(map[string]any)
			if item["type"] == "agentMessage" {
				item["text"] = `{"baton_waiting_for_children":true}`
			}
		}
		tape = replaytest.Replace(t, tape, "event:turn/completed", f)
	}
	var err error
	switch variant {
	case "exit_mid_turn":
		tape, err = tape.CutAfter("response:turn/start")
	case "disconnect":
		tape, err = tape.CutAfter("request:turn/start")
	case "drop_settled":
		tape, err = tape.Drop("event:turn/completed")
	case "free_text":
		f := replaytest.Frame(t, tape, "event:turn/completed")
		turn := f["params"].(map[string]any)["turn"].(map[string]any)
		for _, v := range turn["items"].([]any) {
			item := v.(map[string]any)
			if item["type"] == "agentMessage" {
				item["text"] = "自由文本"
			}
		}
		tape = replaytest.Replace(t, tape, "event:turn/completed", f)
	case "delivery_wrong_id":
		// 两次录制历史查询都只返回相似 ID，保持交付未确认。
		for _, label := range []string{"response:thread/items/list:3", "response:thread/items/list:4"} {
			for _, e := range tape.Entries {
				if e.Label != label {
					continue
				}
				var f map[string]any
				raw := strings.ReplaceAll(string(e.Frame), "<$delivery_id_1>", "wrong-<$delivery_id_1>")
				if err := json.Unmarshal([]byte(raw), &f); err != nil {
					t.Fatal(err)
				}
				tape = replaytest.Replace(t, tape, label, f)
			}
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	crash := ""
	if variant == "exit_mid_turn" {
		tape, crash = replaytest.CrashGate(tape)
	}
	tape, ends := replaytest.EndGates(tape)
	gates := append([]string{}, ends...)
	if crash != "" {
		gates = append(gates, crash)
	}
	if variant != "exit_mid_turn" && variant != "disconnect" && variant != "drop_settled" && scenario != "restore_missing" {
		gates = append(gates, "event:turn/completed")
	}
	if scenario == "delegation" {
		gates = append(gates, "response:thread/items/list:2")
	}
	if hasDelivery {
		gates = append(gates, "response:thread/items/list:3")
	}
	if scenario == "restore_missing" {
		gates = nil
	}
	r := replaytest.Prepare(t, binary, tape, gates...)
	w.replay = r
	t.Setenv("BATON_CODEX_BINARY", r.Binary)
	t.Setenv("BATON_CODEX_HOME", r.Home)
	t.Setenv("BATON_CODEX_MODEL", tape.Header.Model)
	t.Setenv("BATON_TEST_EXECUTOR_LOG", "")
	if scenario == "restore_missing" {
		setup, err := openWorkerDB(w.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := setup.Bind(w.tid, w.eid, "codex"); err != nil {
			t.Fatal(err)
		}
		setup.Close()
		db := w.db(t)
		dir, _ := SessionDir(w.data, w.sid)
		native := filepath.Join(dir, "native")
		if err := os.MkdirAll(native, 0700); err != nil {
			t.Fatal(err)
		}
		c := agent.Config{Binary: r.Binary, Home: r.Home, Directory: r.Work, SessionDir: native, StatePath: filepath.Join(native, "state.json"), Model: tape.Header.Model, SessionID: w.sid, ExecutionID: w.eid}
		f := replaytest.Frame(t, tape, "request:thread/read")
		s := codex.State{Version: codex.Version, ThreadID: f["params"].(map[string]any)["threadId"].(string), Directory: r.Work, SessionID: w.sid}
		raw, _ := json.Marshal(s)
		if err := privatefile.WriteFile(c.StatePath, raw); err != nil {
			t.Fatal(err)
		}
		raw, _ = json.Marshal(c)
		for key, value := range map[string]string{"adapter_config": string(raw), "input_submitted": "1", "start_intent": "1", "input_generation": "1"} {
			if _, err := db.Exec(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value); err != nil {
				t.Fatal(err)
			}
		}
		db.Close()
		w.launch(t)
		w.report(t, protocol.ReportNeedsVerification, func(r protocol.ExecutionReport) bool {
			return r.Status == task.StatusNeedsVerification && r.ErrorCode == task.CodeUncertainHistory
		})
		// Worker 在恢复错误后立即关闭 Agent，以最后一个请求的持久捕获证明转录已被消费。
		raw, err = os.ReadFile(filepath.Join(r.State, "state.json"))
		var replayState struct{ Captures map[string]any }
		request := replaytest.Frame(t, tape, "request:thread/read")["id"].(string)
		if err != nil || json.Unmarshal(raw, &replayState) != nil || replayState.Captures[request] == nil {
			t.Fatal("恢复没有读取录制历史", string(raw), err)
		}
		saved, err := privatefile.ReadFile(c.StatePath)
		var after codex.State
		if err != nil || json.Unmarshal(saved, &after) != nil || after.ThreadID != s.ThreadID {
			t.Fatal("缺失历史替换了会话映射", err)
		}
		return
	}
	w.launch(t)
	w.authorize(t)
	payload, _ := task.MarshalExecutorInput("回放任务", nil, nil, &r.Alias, nil, 1, nil)
	if _, err := w.c.SubmitInput(string(payload)); err != nil {
		t.Fatal(err)
	}
	if _, err := w.c.SubmitInput(string(payload)); err != nil {
		t.Fatal(err)
	}
	if variant == "exit_mid_turn" {
		r.Wait(t, crash)
		r.Release(t, crash)
	}
	if variant == "disconnect" || variant == "exit_mid_turn" {
		w.report(t, protocol.ReportResult, func(r protocol.ExecutionReport) bool { return r.Status == task.StatusNeedsVerification })
		assertCodexOneInput(t, w)
		return
	}
	if scenario == "interrupt_mid_tool" || scenario == "interrupt_before_turn_started" {
		st, err := w.c.Stop(task.StatusCancelled)
		if err != nil {
			t.Fatal(err)
		}
		foundStop := false
		for _, item := range st.Reports {
			if item.Kind == task.EventStopReport {
				foundStop = true
				var report protocol.ExecutionReport
				_ = json.Unmarshal(item.Body, &report)
				if report.AgentStopped || report.OutcomeKnown {
					t.Fatal("ACK 成为停止证据", report)
				}
			}
		}
		if !foundStop {
			t.Fatal("缺少中止 ACK 的初始报告")
		}
	}
	if variant == "drop_settled" {
		r.Wait(t, ends[0])
		db := w.db(t)
		waitCodexFact(t, func() bool {
			var n int
			err := db.QueryRow(`SELECT COUNT(*) FROM execution_log WHERE kind='native_event' AND json_extract(body,'$.item.type')='agentMessage' AND json_extract(body,'$.item.phase')='final_answer'`).Scan(&n)
			if err != nil {
				t.Fatal(err)
			}
			return n > 0
		})
		if st, err := w.c.Pending(); err != nil || len(st.Reports) > 1 {
			t.Fatalf("缺少 settled 提前完成: %+v %v", st, err)
		}
		assertCodexOneInput(t, w)
		return
	}
	if scenario == "delegation" {
		received := make(chan error, 1)
		go func() { _, err := w.c.ReceiveChild(delivery, true); received <- err }()
		r.Wait(t, "response:thread/items/list:2")
		db := w.db(t)
		var status string
		if err := db.QueryRow(`SELECT status FROM child_deliveries WHERE delivery_id=?`, delivery.DeliveryID).Scan(&status); err != nil || status != "uncertain" {
			t.Fatal("result 历史前提前确认", status, err)
		}
		r.Release(t, "response:thread/items/list:2")
		select {
		case err := <-received:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(12 * time.Second):
			t.Fatal("查询交付未返回")
		}
	}

	if hasDelivery {
		db := w.db(t)
		if scenario == "deliver_idle" {
			r.Wait(t, "event:turn/completed")
			r.Release(t, "event:turn/completed")
			waitCodexFact(t, func() bool {
				var value string
				_ = db.QueryRow(`SELECT value FROM meta WHERE key='waiting_children'`).Scan(&value)
				return value == "1"
			})
		} else {
			// 活动回合的交付需已有等待子结果的账本事实；录制测试直接调用 DeliverResult，故在此准备该前置状态。
			if _, err := db.Exec(`INSERT INTO meta(key,value) VALUES('waiting_children','1') ON CONFLICT(key) DO UPDATE SET value='1'`); err != nil {
				t.Fatal(err)
			}
		}
		received := make(chan error, 1)
		go func() { _, err := w.c.ReceiveChild(delivery, false); received <- err }()
		// 完成事件可先到，但 Worker 在查询精确交付历史之前不能给出交付回执。
		if scenario != "deliver_idle" {
			r.Wait(t, "event:turn/completed")
			r.Release(t, "event:turn/completed")
		}
		r.Wait(t, "response:thread/items/list:3")
		var status string
		if err := db.QueryRow(`SELECT status FROM child_deliveries WHERE delivery_id=?`, delivery.DeliveryID).Scan(&status); err != nil || status != "uncertain" {
			t.Fatalf("历史之前的交付状态 %s %v", status, err)
		}
		r.Release(t, "response:thread/items/list:3")
		select {
		case err := <-received:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(12 * time.Second):
			t.Fatal("交付未返回")
		}
		if variant == "delivery_wrong_id" {
			r.Wait(t, ends[0])
			w.report(t, protocol.ReportResult, func(r protocol.ExecutionReport) bool { return r.Status == task.StatusNeedsVerification })
			if err := db.QueryRow(`SELECT status FROM child_deliveries WHERE delivery_id=?`, delivery.DeliveryID).Scan(&status); err != nil || status == "delivered" {
				t.Fatal("错误 ID 被确认", status, err)
			}
			assertCodexOneInput(t, w)
			return
		}
		waitCodexFact(t, func() bool {
			st, err := w.c.Pending()
			if err != nil {
				t.Fatal(err)
			}
			for _, receipt := range st.ChildReceipts {
				if receipt.DeliveryID == delivery.DeliveryID {
					return receipt.Status == "delivered"
				}
			}
			return false
		})
		if _, err := w.c.ReceiveChild(delivery, false); err != nil {
			t.Fatal(err)
		}
	} else {
		r.Wait(t, "event:turn/completed")
		r.Release(t, "event:turn/completed")
	}
	if scenario == "interrupt_mid_tool" || scenario == "interrupt_before_turn_started" {
		report := w.report(t, task.EventStopReport, func(r protocol.ExecutionReport) bool {
			return r.AgentStopped && !r.OutcomeKnown && r.Status == task.StatusNeedsVerification
		})
		if _, err := w.c.Ack(report.EventID); err != nil {
			t.Fatal(err)
		}
	} else if scenario == "interrupt_idle" {
		w.report(t, protocol.ReportResult, func(r protocol.ExecutionReport) bool { return r.Status == task.StatusCompleted })
		if _, err := w.c.Stop(task.StatusCancelled); err != nil {
			t.Fatal(err)
		}
		w.report(t, task.EventStopReport, func(r protocol.ExecutionReport) bool { return r.AgentStopped && r.OutcomeKnown })
	} else {
		want := task.StatusCompleted
		if scenario == "provider_error" {
			want = task.StatusNeedsVerification
		}
		if variant == "free_text" {
			want = task.StatusFailed
		}
		report := w.report(t, protocol.ReportResult, func(r protocol.ExecutionReport) bool { return r.Status == want })
		if report.TaskID != w.tid || report.ExecutionID != w.eid || report.SessionID != w.sid {
			t.Fatal("结果身份不匹配", report)
		}
	}
	r.Wait(t, ends[0])
	if scenario == "delegation" {
		st, err := w.c.ReceiveChild(delivery, true)
		if err != nil || len(st.ChildReceipts) != 1 || st.ChildReceipts[0].Status != "delivered" {
			t.Fatal("查询交付确认", st, err)
		}
	}
	assertCodexOneInput(t, w)
	if scenario == "restore_load_only" {
		before := w.report(t, protocol.ReportResult, func(r protocol.ExecutionReport) bool { return r.Status == task.StatusCompleted })
		w.stop()
		w.launch(t)
		after := w.report(t, protocol.ReportResult, func(r protocol.ExecutionReport) bool { return r.Status == task.StatusCompleted })
		if after.EventID != before.EventID {
			t.Fatal("恢复没有补报同一 outbox 结果")
		}
		r.Wait(t, ends[1])
		assertCodexOneInput(t, w)
		dir, _ := SessionDir(w.data, w.sid)
		raw, err := privatefile.ReadFile(filepath.Join(dir, "native", "state.json"))
		var state codex.State
		if err != nil || json.Unmarshal(raw, &state) != nil || state.ThreadID != "thread-1" || state.TurnID != "turn-1" {
			t.Fatal("恢复替换原生身份", err)
		}
	}
}
func assertCodexOneInput(t *testing.T, w *codexWorkerRun) {
	t.Helper()
	db := w.db(t)
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM meta WHERE key='start_intent' AND value='1'`).Scan(&n); err != nil || n != 1 {
		t.Fatal("启动意图次数", n, err)
	}
	var inputs int
	if err := db.QueryRow(`SELECT COUNT(*) FROM execution_log WHERE kind='input' AND json_extract(body,'$.generation')=1`).Scan(&inputs); err != nil || inputs > 1 {
		t.Fatal("任务输入次数", inputs, err)
	}
	raw, err := os.ReadFile(filepath.Join(w.replay.State, "state.json"))
	var state struct{ Captures map[string]any }
	if err != nil || json.Unmarshal(raw, &state) != nil || (state.Captures["<$operation_id_1>"] != w.eid+":1" && state.Captures["<$execution_id_1>"] != w.eid) {
		t.Fatal("原生任务输入身份", string(raw), err)
	}
	st, err := w.c.Pending()
	if err != nil || !st.InputSubmitted {
		t.Fatal("输入意图丢失", err)
	}
}
