package session

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"baton/internal/agent"
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
	if _, err := w.adapterFactory("codex", `{}`); err == nil {
		t.Fatal("unimplemented agent used observer")
	}
}
