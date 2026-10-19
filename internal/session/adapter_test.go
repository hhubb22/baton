package session

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
	"baton/internal/agent/codex"
	"baton/internal/agent/pi"
	"baton/internal/agent/shell"
	"baton/internal/protocol"
	"baton/internal/task"
)

type nativeStub struct {
	starts, inputs, deliveries, aborts int
	history                            bool
	queried                            bool
	outputs                            []Output
}

const nativeTestInput = `{"description":"task"}`

func (a *nativeStub) Start(context.Context) error { a.starts++; return nil }
func (a *nativeStub) SubmitInput(context.Context, string) (Output, error) {
	a.inputs++
	return Output{}, nil
}
func (a *nativeStub) DeliverResult(context.Context, string, string) (Output, error) {
	a.deliveries++
	return Output{}, nil
}
func (a *nativeStub) HistoryContains(_ string, queried bool) (bool, error) {
	a.queried = queried
	return a.history, nil
}
func (a *nativeStub) Drain() []Output            { out := a.outputs; a.outputs = nil; return out }
func (a *nativeStub) Abort() (bool, bool, error) { a.aborts++; return true, false, nil }
func (*nativeStub) Close() error                 { return nil }
func (*nativeStub) ReadHistory(context.Context, string) (agent.HistoryPage, error) {
	return agent.HistoryPage{Data: json.RawMessage(`[]`)}, nil
}

type delayedStopStub struct {
	*nativeStub
	settled, known bool
}

func (a *delayedStopStub) Abort() (bool, bool, error) {
	a.aborts++
	return false, false, errors.New("abort not settled")
}

func (a *delayedStopStub) StopStatus() (bool, bool) { return a.settled, a.settled && a.known }

func TestNativeWorkerConfirmsDelayedStop(t *testing.T) {
	for _, reason := range []string{task.StatusCancelled, task.CodeExecutionTimeout} {
		t.Run(reason, func(t *testing.T) {
			w, clock, sid := clockWorker(t, 60)
			a := &delayedStopStub{nativeStub: &nativeStub{}}
			w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
			if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
				t.Fatal(err)
			}
			reports, err := w.Stop(sid, reason)
			if err != nil {
				t.Fatal(err)
			}
			first := findStop(t, reports)
			if first.AgentStopped || first.OutcomeKnown || first.NotStarted {
				t.Fatalf("request invented stop evidence: %+v", first)
			}
			if err := w.Ack(first.EventID); err != nil {
				t.Fatal(err)
			}
			clock.Advance(15 * time.Second)
			a.settled = true
			if err := w.checkDeadline(sid); err != nil {
				t.Fatal(err)
			}
			reports, err = w.Pending()
			if err != nil {
				t.Fatal(err)
			}
			confirmed := findStop(t, reports)
			if !confirmed.AgentStopped || confirmed.OutcomeKnown || confirmed.NotStarted || confirmed.Status != task.StatusNeedsVerification || confirmed.StopReason != reason || confirmed.EventID == first.EventID || confirmed.WorkerSequence <= first.WorkerSequence || !confirmed.OccurredAt.After(first.OccurredAt) {
				t.Fatalf("late settlement lost stop/unknown outcome: %+v", confirmed)
			}
			for i := 0; i < 3; i++ {
				if err := w.checkDeadline(sid); err != nil {
					t.Fatal(err)
				}
				if _, err := w.Stop(sid, reason); err != nil {
					t.Fatal(err)
				}
			}
			var count int
			if err := w.db.QueryRow(`SELECT COUNT(*) FROM outbox WHERE kind = ?`, task.EventStopReport).Scan(&count); err != nil || count != 2 || a.aborts != 1 {
				t.Fatalf("duplicate stop reports/control calls: %d %d %v", count, a.aborts, err)
			}
			if err := w.Ack(confirmed.EventID); err != nil {
				t.Fatal(err)
			}
			var seq int
			var name, path string
			if err := w.db.QueryRow(`PRAGMA database_list`).Scan(&seq, &name, &path); err != nil {
				t.Fatal(err)
			}
			if err := w.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := openWorkerDB(path, NewObserver(""))
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			if err := reopened.checkDeadline(sid); err != nil {
				t.Fatal(err)
			}
			reports, err = reopened.Stop(sid, reason)
			if err != nil {
				t.Fatalf("acknowledged stop replayed after reopen: %+v %v", reports, err)
			}
			for _, r := range reports {
				if r.Kind == task.EventStopReport || r.Kind == protocol.ReportResult {
					t.Fatalf("stop/result replayed after reopen: %+v", r)
				}
			}
			if err := reopened.db.QueryRow(`SELECT COUNT(*) FROM outbox WHERE kind = ?`, task.EventStopReport).Scan(&count); err != nil || count != 2 {
				t.Fatalf("reopen duplicated stop reports: %d %v", count, err)
			}
		})
	}
}

func TestNativeWorkerRetriesStopConfirmationAfterLedgerFailure(t *testing.T) {
	w, _, sid := clockWorker(t, 60)
	a := &delayedStopStub{nativeStub: &nativeStub{}, known: true}
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
	if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
		t.Fatal(err)
	}
	reports, err := w.Stop(sid, task.StatusCancelled)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Ack(findStop(t, reports).EventID); err != nil {
		t.Fatal(err)
	}
	if _, err := w.db.Exec(`CREATE TRIGGER fail_stop BEFORE INSERT ON outbox WHEN NEW.kind = 'stop_report'
	 BEGIN SELECT RAISE(ABORT, 'fixture ledger failure'); END`); err != nil {
		t.Fatal(err)
	}
	a.settled = true
	if err := w.checkDeadline(sid); err == nil {
		t.Fatal("ledger failure was swallowed")
	}
	if _, err := w.db.Exec(`DROP TRIGGER fail_stop`); err != nil {
		t.Fatal(err)
	}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	reports, err = w.Pending()
	if err != nil {
		t.Fatal(err)
	}
	confirmed := findStop(t, reports)
	if !confirmed.AgentStopped || !confirmed.OutcomeKnown || confirmed.NotStarted || a.aborts != 1 {
		t.Fatalf("retry lost no-tool stop evidence: %+v, aborts=%d", confirmed, a.aborts)
	}
}

func TestNativeWorkerUsesAsyncSettlementAndHistoryConfirmation(t *testing.T) {
	for _, queried := range []bool{false, true} {
		t.Run(map[bool]string{false: "automatic", true: "query"}[queried], func(t *testing.T) {
			w, _, sid := clockWorker(t, 60)
			a := &nativeStub{}
			w.adapterFactory = func(typ, payload string) (agent.Adapter, error) {
				if typ != "pi" || payload != nativeTestInput {
					t.Fatal("wrong adapter input")
				}
				return a, nil
			}
			if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
				t.Fatal(err)
			}
			if a.starts != 1 || a.inputs != 1 {
				t.Fatal("adapter was not used")
			}
			var stopped string
			_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'agent_stopped'`).Scan(&stopped)
			if stopped == "1" {
				t.Fatal("prompt response completed execution")
			}
			if !queried {
				a.outputs = []Output{{WaitingForChildren: true}}
				if err := w.checkDeadline(sid); err != nil {
					t.Fatal(err)
				}
			}
			d := childInput(t, w, sid)
			if err := w.ReceiveChild(sid, d, queried); err != nil {
				t.Fatal(err)
			}
			if err := w.ReceiveChild(sid, d, queried); err != nil {
				t.Fatal(err)
			}
			r, err := w.ChildReceipts()
			if err != nil || len(r) != 0 {
				t.Fatalf("RPC response mistaken for history confirmation: %+v %v", r, err)
			}
			a.history = true
			if err := w.checkDeadline(sid); err != nil {
				t.Fatal(err)
			}
			r, err = w.ChildReceipts()
			if err != nil || len(r) != 1 || r[0].Status != "delivered" || r[0].Generation != 2 || a.queried != queried {
				t.Fatalf("native confirmation: %+v %v", r, err)
			}
			if (!queried && a.deliveries != 1) || (queried && a.deliveries != 0) {
				t.Fatal("duplicate result injection")
			}
			if w.deliveryUncertain {
				t.Fatal("confirmed delivery blocked subsequent children")
			}
			a.outputs = []Output{{Exited: true, Final: `{"status":"completed","summary":"native","evidence":[],"evidence_empty_reason":"fixture","artifacts":[],"artifacts_empty_reason":"fixture","error":null}`}}
			if err := w.checkDeadline(sid); err != nil {
				t.Fatal(err)
			}
			reports, err := w.Pending()
			if err != nil {
				t.Fatal(err)
			}
			var result protocol.ExecutionReport
			for _, r := range reports {
				if r.Kind == protocol.ReportResult {
					_ = json.Unmarshal(r.Body, &result)
				}
			}
			if result.Summary != "native" || result.InputGeneration != 2 || !result.AgentStopped {
				t.Fatalf("settled report: %+v", result)
			}
		})
	}
}

func TestNativeWorkerExitAndUnconfirmedHistoryRemainUncertain(t *testing.T) {
	for _, missingHistory := range []bool{false, true} {
		t.Run(map[bool]string{false: "process_exit", true: "missing_history"}[missingHistory], func(t *testing.T) {
			w, _, sid := clockWorker(t, 60)
			a := &nativeStub{}
			w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
			if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
				t.Fatal(err)
			}
			if missingHistory {
				if _, err := w.db.Exec(`INSERT INTO meta(key,value) VALUES ('waiting_children','1') ON CONFLICT(key) DO UPDATE SET value='1'`); err != nil {
					t.Fatal(err)
				}
				if err := w.ReceiveChild(sid, childInput(t, w, sid), false); err != nil {
					t.Fatal(err)
				}
			}
			a.outputs = []Output{{Uncertain: true}}
			if err := w.checkDeadline(sid); err != nil {
				t.Fatal(err)
			}
			reports, err := w.Pending()
			if err != nil {
				t.Fatal(err)
			}
			for _, r := range reports {
				if r.Kind == protocol.ReportResult {
					var result protocol.ExecutionReport
					_ = json.Unmarshal(r.Body, &result)
					if result.Status != "needs_verification" || result.AgentStopped {
						t.Fatalf("false stopping fact: %+v", result)
					}
					if missingHistory {
						r, err := w.ChildReceipts()
						if err != nil || len(r) != 1 || r[0].Status != "uncertain" {
							t.Fatalf("missing uncertain receipt: %+v %v", r, err)
						}
					}
					return
				}
			}
			t.Fatal("missing uncertainty report")
		})
	}
}

func TestNativeWorkerCrashKeepsUncertainReceiptWithoutReinjection(t *testing.T) {
	w, _, sid := clockWorker(t, 60)
	a := &nativeStub{}
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
	if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
		t.Fatal(err)
	}
	a.outputs = []Output{{WaitingForChildren: true}}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	d := childInput(t, w, sid)
	if err := w.ReceiveChild(sid, d, false); err != nil {
		t.Fatal(err)
	}
	var seq int
	var name, path string
	if err := w.db.QueryRow(`PRAGMA database_list`).Scan(&seq, &name, &path); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := openWorkerDB(path, NewObserver(""))
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if err := b.recover(sid); err != nil {
		t.Fatal(err)
	}
	if err := b.ReceiveChild(sid, d, false); err != nil {
		t.Fatal(err)
	}
	r, err := b.ChildReceipts()
	if err != nil || len(r) != 1 || r[0].Status != "uncertain" || r[0].Generation != 2 {
		t.Fatalf("lost uncertain receipt: %+v %v", r, err)
	}
	if a.deliveries != 1 || !b.recoveredUncertain || b.adapter != nil {
		t.Fatal("recovery re-injected a native result")
	}
}

func TestNativeWorkerHistoryMissingProducesHistoryUncertainty(t *testing.T) {
	w, _, sid := clockWorker(t, 60)
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return nil, agent.ErrHistoryMissing }
	reports, err := w.SubmitInput(sid, nativeTestInput)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range reports {
		var result protocol.ExecutionReport
		if err := json.Unmarshal(r.Body, &result); err != nil {
			t.Fatal(err)
		}
		if result.ErrorCode == task.CodeUncertainHistory {
			return
		}
	}
	t.Fatal("missing history was not reported distinctly")
}

func TestNativeWorkerStopsLiveAdapterEvenIfInputIsUncertain(t *testing.T) {
	w, _, sid := clockWorker(t, 60)
	a := &nativeStub{}
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
	if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
		t.Fatal(err)
	}
	w.recoveredUncertain = true
	if _, err := w.Stop(sid, task.StatusCancelled); err != nil {
		t.Fatal(err)
	}
	if a.aborts != 1 {
		t.Fatal("live native process escaped abort after an uncertain prompt response")
	}
}

func TestAdapterSelectionRejectsMissingNativeHistory(t *testing.T) {
	w, _, sid := clockWorker(t, 60)
	dir := t.TempDir()
	sessionDir, err := SessionDir(dir, sid)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(sessionDir, "native"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BATON_TEST_EXECUTOR_LOG", "")
	configureAdapter(w, dir, sid)
	a, err := w.adapterFactory("pi", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Start(context.Background()); err == nil {
		a.Close()
		t.Fatal("empty native directory restored as a new session")
	}
	if _, err := w.adapterFactory("unknown", `{}`); err == nil {
		t.Fatal("unimplemented agent used observer")
	}
}

func TestSharedAdapterRegistration(t *testing.T) {
	t.Setenv("BATON_TEST_EXECUTOR_LOG", "")
	for _, name := range []string{"pi", "codex", "shell"} {
		t.Run(name, func(t *testing.T) {
			w, _, sid := clockWorker(t, 60)
			configureAdapter(w, t.TempDir(), sid)
			a, err := w.adapterFactory(name, `{}`)
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close()
			switch name {
			case "shell":
				if _, ok := a.(*shell.Adapter); !ok {
					t.Fatal("shell 未注册")
				}
			case "pi":
				if _, ok := a.(*pi.Adapter); !ok {
					t.Fatal("Pi not registered")
				}
			case "codex":
				if _, ok := a.(*codex.Adapter); !ok {
					t.Fatal("Codex not registered")
				}
			}
			var saved string
			if err := w.db.QueryRow(`SELECT value FROM meta WHERE key='adapter_config'`).Scan(&saved); err != nil {
				t.Fatal(err)
			}
			var config agent.Config
			if json.Unmarshal([]byte(saved), &config) != nil || config.SessionID != sid || config.ExecutionID != w.execution || config.Restore {
				t.Fatal("invalid native binding")
			}
		})
	}
	t.Run("new-registration", func(t *testing.T) {
		stub := &nativeStub{}
		registeredAdapters["shell-fixture"] = adapterRegistration{new: func(agent.Config) agent.Adapter { return stub }}
		defer delete(registeredAdapters, "shell-fixture")
		w, _, sid := clockWorker(t, 60)
		if _, err := w.db.Exec(`UPDATE meta SET value='shell-fixture' WHERE key='agent_type'`); err != nil {
			t.Fatal(err)
		}
		configureAdapter(w, t.TempDir(), sid)
		if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
			t.Fatal(err)
		}
		if stub.starts != 1 || stub.inputs != 1 {
			t.Fatal("registration bypassed common lifecycle")
		}
		if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
			t.Fatal(err)
		}
		if stub.inputs != 1 {
			t.Fatal("duplicate input replayed")
		}
		if _, err := w.readNativeHistory(""); err != nil {
			t.Fatal(err)
		}
		if _, err := w.Stop(sid, task.StatusCancelled); err != nil || stub.aborts != 1 {
			t.Fatal("registration bypassed abort", err)
		}
	})
}

func TestAdapterConfigExcludesEnvironment(t *testing.T) {
	raw, err := json.Marshal(agent.Config{Env: []string{"TEST_SECRET=fixture-secret-not-to-persist"}, Model: "fixture-model"})
	if err != nil || strings.Contains(string(raw), "fixture-secret") || strings.Contains(string(raw), "TEST_SECRET") {
		t.Fatal("Agent environment leaked into persisted config", err)
	}
}

type stopOutputStub struct {
	*nativeStub
	output    Output
	settled   bool
	immediate bool
}

func (a *stopOutputStub) Abort() (bool, bool, error) {
	a.aborts++
	if a.immediate {
		a.settled = true
		a.outputs = append(a.outputs, a.output)
	}
	return a.settled, false, nil
}
func (a *stopOutputStub) StopStatus() (bool, bool) { return a.settled, false }
func commandStopOutput(t *testing.T) Output {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"summary": "命令已停止", "status": task.StatusFailed,
		"evidence_empty_reason": "输出记录在命令结果中", "artifacts_empty_reason": "没有声明产物",
		"error":          map[string]string{"code": task.CodeExecutionFailed, "message": "进程已停止"},
		"command_result": task.CommandResult{Output: "partial\n", TotalBytes: 8, ExitCode: -1},
	})
	if err != nil {
		t.Fatal(err)
	}
	return Output{Final: string(raw), Exited: true}
}
func assertStoppedCommandOutput(t *testing.T, w *workerDB, sid, reason string) protocol.ExecutionReport {
	t.Helper()
	reports, err := w.Pending()
	if err != nil {
		t.Fatal(err)
	}
	var stop protocol.ExecutionReport
	for _, r := range reports {
		if r.Kind == task.EventStopReport {
			if err := json.Unmarshal(r.Body, &stop); err != nil {
				t.Fatal(err)
			}
		}
	}
	if stop.Status != task.StatusNeedsVerification || stop.StopReason != reason || !stop.AgentStopped || stop.OutcomeKnown || stop.CommandResult == nil || stop.CommandResult.Output != "partial\n" || stop.CommandResult.TotalBytes != 8 || stop.CommandResult.ExitCode != -1 {
		t.Fatalf("停止报告丢失输出或改变停止事实: %+v", stop)
	}
	var resultCount, outputCount int
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM outbox WHERE kind=?`, protocol.ReportResult).Scan(&resultCount); err != nil {
		t.Fatal(err)
	}
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM execution_log WHERE kind='output'`).Scan(&outputCount); err != nil {
		t.Fatal(err)
	}
	if resultCount != 0 || outputCount != 1 {
		t.Fatalf("停止后输出没有只审计一次: results=%d outputs=%d", resultCount, outputCount)
	}
	return stop
}
func TestWorkerStopIncludesCommandOutputWithoutFinalResult(t *testing.T) {
	for _, reason := range []string{task.StatusCancelled, task.CodeExecutionTimeout} {
		t.Run(reason, func(t *testing.T) {
			w, clock, sid := clockWorker(t, 1)
			a := &stopOutputStub{nativeStub: &nativeStub{}, output: commandStopOutput(t), immediate: true}
			w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
			if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
				t.Fatal(err)
			}
			if reason == task.CodeExecutionTimeout {
				clock.Advance(time.Second)
				if err := w.checkDeadline(sid); err != nil {
					t.Fatal(err)
				}
			} else if _, err := w.Stop(sid, reason); err != nil {
				t.Fatal(err)
			}
			stop := assertStoppedCommandOutput(t, w, sid, reason)
			if err := w.checkDeadline(sid); err != nil {
				t.Fatal(err)
			}
			after := assertStoppedCommandOutput(t, w, sid, reason)
			if stop.EventID != after.EventID || a.aborts != 1 {
				t.Fatal("重复轮询产生了第二次停止或报告")
			}
			var seq int
			var name, path string
			if err := w.db.QueryRow(`PRAGMA database_list`).Scan(&seq, &name, &path); err != nil {
				t.Fatal(err)
			}
			if err := w.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := openWorkerDB(path, NewObserver(""))
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			if _, err := reopened.Stop(sid, reason); err != nil {
				t.Fatal(err)
			}
			assertStoppedCommandOutput(t, reopened, sid, reason)
		})
	}
}
func TestWorkerStopRetainsLateCommandOutput(t *testing.T) {
	for _, initialStopped := range []bool{false, true} {
		name := "停止事实与输出同时到达"
		if initialStopped {
			name = "输出在停止事实之后到达"
		}
		t.Run(name, func(t *testing.T) {
			w, _, sid := clockWorker(t, 60)
			a := &stopOutputStub{nativeStub: &nativeStub{}, output: commandStopOutput(t), settled: initialStopped}
			w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
			if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
				t.Fatal(err)
			}
			initial, err := w.Stop(sid, task.StatusCancelled)
			if err != nil {
				t.Fatal(err)
			}
			first := findStop(t, initial)
			if first.AgentStopped != initialStopped || first.CommandResult != nil {
				t.Fatal("首次停止请求凭空生成了停止事实或输出")
			}
			if err := w.Ack(first.EventID); err != nil {
				t.Fatal(err)
			}
			a.outputs = append(a.outputs, a.output)
			a.settled = true
			if err := w.checkDeadline(sid); err != nil {
				t.Fatal(err)
			}
			stop := assertStoppedCommandOutput(t, w, sid, task.StatusCancelled)
			if stop.EventID == first.EventID || stop.WorkerSequence <= first.WorkerSequence {
				t.Fatal("延迟输出没有生成可重放的新报告")
			}
		})
	}
}

func TestWorkerRetriesStoppedCommandOutputAfterLedgerFailure(t *testing.T) {
	w, _, sid := clockWorker(t, 60)
	a := &stopOutputStub{nativeStub: &nativeStub{}, output: commandStopOutput(t), immediate: true}
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
	if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
		t.Fatal(err)
	}
	if _, err := w.db.Exec(`CREATE TRIGGER fail_stop_output BEFORE INSERT ON meta WHEN NEW.key='stop_output' BEGIN SELECT RAISE(ABORT,'fixture output write failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Stop(sid, task.StatusCancelled); err == nil {
		t.Fatal("输出账本失败被吞掉")
	}
	if len(a.outputs) != 0 || w.pendingStopOutput == "" {
		t.Fatal("已读取的输出没有保留供重试")
	}
	if _, err := w.db.Exec(`DROP TRIGGER fail_stop_output`); err != nil {
		t.Fatal(err)
	}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	assertStoppedCommandOutput(t, w, sid, task.StatusCancelled)
	if a.aborts != 1 || w.pendingStopOutput != "" {
		t.Fatal("恢复输出时重复中止或未清理内存副本")
	}
}

func TestStopReportPreservesOutputAndAddsKnownOutcome(t *testing.T) {
	w, _, sid := clockWorker(t, 60)
	w.stopReason = task.StatusCancelled
	w.pendingStopOutput = commandStopOutput(t).Final
	if err := w.flushStopOutputLocked(); err != nil {
		t.Fatal(err)
	}
	initial, err := w.recordStopReportLocked(sid, true, false, false)
	if err != nil {
		t.Fatal(err)
	}
	first := findStop(t, initial)
	if first.CommandResult == nil || first.OutcomeKnown {
		t.Fatal("初始停止报告没有保存预期事实")
	}
	if err := w.Ack(first.EventID); err != nil {
		t.Fatal(err)
	}
	// 输出已经在报告里，后续状态来源即使没有再次提供输出也应保留它。
	if _, err := w.db.Exec(`DELETE FROM meta WHERE key='stop_output'`); err != nil {
		t.Fatal(err)
	}
	reports, err := w.recordStopReportLocked(sid, true, true, false)
	if err != nil {
		t.Fatal(err)
	}
	stop := findStop(t, reports)
	if !stop.OutcomeKnown || stop.CommandResult == nil || *stop.CommandResult != *first.CommandResult || stop.WorkerSequence <= first.WorkerSequence {
		t.Fatalf("新增停止证据或原有输出被丢弃: %+v", stop)
	}
}

func TestWorkerRecoversPersistedOutputBeforeStopReportUpdate(t *testing.T) {
	w, _, sid := clockWorker(t, 60)
	a := &stopOutputStub{nativeStub: &nativeStub{}}
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
	if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
		t.Fatal(err)
	}
	initial, err := w.Stop(sid, task.StatusCancelled)
	if err != nil {
		t.Fatal(err)
	}
	first := findStop(t, initial)
	if err := w.Ack(first.EventID); err != nil {
		t.Fatal(err)
	}
	// 模拟输出保存后、更新停止报告前发生 Worker 崩溃。
	w.pendingStopOutput = commandStopOutput(t).Final
	if err := w.flushStopOutputLocked(); err != nil {
		t.Fatal(err)
	}
	var seq int
	var name, path string
	if err := w.db.QueryRow(`PRAGMA database_list`).Scan(&seq, &name, &path); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openWorkerDB(path, NewObserver(""))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.recover(sid); err != nil {
		t.Fatal(err)
	}
	reports, err := reopened.Pending()
	if err != nil {
		t.Fatal(err)
	}
	stop := findStop(t, reports)
	if stop.CommandResult == nil || stop.CommandResult.Output != "partial\n" || stop.EventID == first.EventID || stop.OutcomeKnown || stop.Status != task.StatusNeedsVerification {
		t.Fatalf("恢复时丢失了已保存的停止输出: %+v", stop)
	}
}
