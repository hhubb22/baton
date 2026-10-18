package session

import (
	"encoding/json"
	"testing"

	"baton/internal/protocol"
	"baton/internal/task"
)

func childInput(t *testing.T, w *workerDB, sid string) protocol.ChildDelivery {
	t.Helper()
	return protocol.ChildDelivery{DeliveryID: mustSessionID(t), TaskID: w.task, ExecutionID: w.execution, SessionID: sid, ChildTaskID: mustSessionID(t), Result: json.RawMessage(`{"status":"completed","summary":"子结果"}`)}
}

func TestChildDeliveryPersistsOnceAndAdvancesGeneration(t *testing.T) {
	t.Setenv("BATON_TEST_EXECUTOR_SCRIPT", "candidate_waiting")
	t.Setenv("BATON_TEST_DELIVERY_SCRIPT", "success")
	w, _, sid := clockWorker(t, 60)
	if _, err := w.SubmitInput(sid, "原任务"); err != nil {
		t.Fatal(err)
	}
	pending, err := w.Pending()
	if err != nil || len(pending) != 1 || pending[0].Kind != protocol.ReportStarted {
		t.Fatalf("存活候选不应成为完成报告: %+v %v", pending, err)
	}
	d := childInput(t, w, sid)
	if err := w.ReceiveChild(sid, d, false); err != nil {
		t.Fatal(err)
	}
	if err := w.ReceiveChild(sid, d, false); err != nil {
		t.Fatal(err)
	}
	receipts, err := w.ChildReceipts()
	if err != nil || len(receipts) != 1 || receipts[0].Status != "delivered" || receipts[0].Generation != 2 {
		t.Fatalf("交付: %+v %v", receipts, err)
	}
	starts, inputs := w.observer.Starts(), w.observer.Inputs()
	if starts != 1 || inputs != 2 {
		t.Fatalf("重复注入/启动: %d %d", starts, inputs)
	}
	reports, err := w.Pending()
	if err != nil {
		t.Fatal(err)
	}
	var results int
	for _, raw := range reports {
		if raw.Kind != protocol.ReportResult {
			continue
		}
		var r protocol.ExecutionReport
		if err := json.Unmarshal(raw.Body, &r); err != nil {
			t.Fatal(err)
		}
		if r.InputGeneration != 2 || !r.AgentStopped || r.Summary != SuccessSummary {
			t.Fatalf("错误的候选代次: %+v", r)
		}
		results++
	}
	if results != 1 {
		t.Fatalf("结果数量: %d", results)
	}
}

func TestChildDeliveryOnlyContinuesWaitingLiveAgent(t *testing.T) {
	for _, mode := range []string{"busy", "query", "stopped", "uncertain"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("BATON_TEST_EXECUTOR_SCRIPT", "running")
			w, _, sid := clockWorker(t, 60)
			if _, err := w.SubmitInput(sid, "原任务"); err != nil {
				t.Fatal(err)
			}
			if mode == "stopped" {
				if _, err := w.Stop(sid, task.StatusCancelled); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "uncertain" {
				w.deliveryUncertain = true
			}
			d := childInput(t, w, sid)
			if err := w.ReceiveChild(sid, d, mode == "query"); err != nil {
				t.Fatal(err)
			}
			if err := w.ReceiveChild(sid, d, mode == "query"); err != nil {
				t.Fatal(err)
			}
			receipts, err := w.ChildReceipts()
			if err != nil || len(receipts) != 1 {
				t.Fatalf("通知: %+v %v", receipts, err)
			}
			expected := "available"
			if mode == "stopped" {
				expected = "source_stopped"
			}
			if mode == "query" {
				expected = "delivered"
			}
			if receipts[0].Status != expected {
				t.Fatalf("状态: %+v", receipts)
			}
			starts, inputs := w.observer.Starts(), w.observer.Inputs()
			if starts != 1 || inputs != 1 {
				t.Fatalf("通知不应额外注入: %d %d", starts, inputs)
			}
			if (w.generation == 2) != (mode == "query") {
				t.Fatalf("代次: %d", w.generation)
			}
		})
	}
}

func TestOldCandidateCannotCompleteAfterChildQuery(t *testing.T) {
	t.Setenv("BATON_TEST_EXECUTOR_SCRIPT", "candidate_waiting")
	w, _, sid := clockWorker(t, 60)
	if _, err := w.SubmitInput(sid, "原任务"); err != nil {
		t.Fatal(err)
	}
	if err := w.ReceiveChild(sid, childInput(t, w, sid), true); err != nil {
		t.Fatal(err)
	}
	if _, err := w.recordExecution(sid, "", Output{Exited: true}); err != nil {
		t.Fatal(err)
	}
	reports, err := w.Pending()
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range reports {
		if raw.Kind != protocol.ReportResult {
			continue
		}
		var r protocol.ExecutionReport
		if err := json.Unmarshal(raw.Body, &r); err != nil {
			t.Fatal(err)
		}
		if r.Status == task.StatusCompleted {
			t.Fatal("子结果进入后使用旧候选完成")
		}
	}
}

func TestCurrentCandidateCompletesOnlyAfterAgentStops(t *testing.T) {
	t.Setenv("BATON_TEST_EXECUTOR_SCRIPT", "candidate_waiting")
	w, _, sid := clockWorker(t, 60)
	if _, err := w.SubmitInput(sid, "原任务"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.recordExecution(sid, "", Output{Exited: true}); err != nil {
		t.Fatal(err)
	}
	reports, err := w.Pending()
	if err != nil {
		t.Fatal(err)
	}
	var started, completed int
	for _, raw := range reports {
		var r protocol.ExecutionReport
		if err := json.Unmarshal(raw.Body, &r); err != nil {
			t.Fatal(err)
		}
		if raw.Kind == protocol.ReportStarted {
			started++
		}
		if raw.Kind == protocol.ReportResult && r.Status == task.StatusCompleted && r.AgentStopped && r.InputGeneration == 1 {
			completed++
		}
	}
	if started != 1 || completed != 1 {
		t.Fatalf("回执: %+v", reports)
	}
	if err := w.ReceiveChild(sid, childInput(t, w, sid), true); err != nil {
		t.Fatal(err)
	}
	receipts, err := w.ChildReceipts()
	if err != nil || len(receipts) != 1 || receipts[0].Status != "source_stopped" || w.generation != 1 {
		t.Fatalf("停止后仍接收新输入: %+v %v", receipts, err)
	}
}

func TestChildDeliveryUnconfirmedHistoryDoesNotReinject(t *testing.T) {
	t.Setenv("BATON_TEST_EXECUTOR_SCRIPT", "candidate_waiting")
	w, _, sid := clockWorker(t, 60)
	if _, err := w.SubmitInput(sid, "原任务"); err != nil {
		t.Fatal(err)
	}
	w.observer.path = t.TempDir()
	d := childInput(t, w, sid)
	if err := w.ReceiveChild(sid, d, false); err != nil {
		t.Fatal(err)
	}
	if err := w.ReceiveChild(sid, d, false); err != nil {
		t.Fatal(err)
	}
	if err := w.ReceiveChild(sid, childInput(t, w, sid), true); err != nil {
		t.Fatal(err)
	}
	receipts, err := w.ChildReceipts()
	if err != nil || len(receipts) != 2 {
		t.Fatalf("账本: %+v %v", receipts, err)
	}
	var uncertain, available int
	for _, r := range receipts {
		if r.Status == "uncertain" && r.Generation == 2 {
			uncertain++
		}
		if r.Status == "available" && r.Generation == 0 {
			available++
		}
	}
	if uncertain != 1 || available != 1 || w.generation != 2 || w.observer.Inputs() != 2 {
		t.Fatalf("未确认的交付被重放: %+v", receipts)
	}
}
