package session

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/protocol"
)

func TestAuthorizeIdentityMismatchDoesNotRefuseBoundExecution(t *testing.T) {
	for _, state := range []string{"unbound", "other_execution", "other_task"} {
		t.Run(state, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "worker.db")
			if err := CreateLedger(path); err != nil {
				t.Fatal(err)
			}
			w, err := openWorkerDB(path, NewObserver(""))
			if err != nil {
				t.Fatal(err)
			}
			defer w.Close()
			taskID, executionID := mustSessionID(t), mustSessionID(t)
			if state != "unbound" {
				if err := w.Bind(taskID, executionID, "pi"); err != nil {
					t.Fatal(err)
				}
			}
			requestTask, requestExecution := taskID, executionID
			if state == "other_task" {
				requestTask = mustSessionID(t)
			} else {
				requestExecution = mustSessionID(t)
			}
			started, refused, code, err := w.Authorize(requestTask, requestExecution, "", "", "", time.Time{})
			if err != nil || started || !refused || code != "invalid_target" {
				t.Fatalf("身份不匹配没有拒绝: %v %v %s %v", started, refused, code, err)
			}
			var count int
			if err := w.db.QueryRow(`SELECT COUNT(*) FROM meta WHERE key = 'start_refused'`).Scan(&count); err != nil || count != 0 {
				t.Fatalf("拒绝污染了本 Session: %d %v", count, err)
			}
			if err := w.Bind(taskID, executionID, "pi"); err != nil {
				t.Fatal(err)
			}
			if _, err := w.Arm(taskID, executionID); err != nil {
				t.Fatal(err)
			}
			needs, err := LedgerNeedsWorker(path)
			if err != nil || !needs {
				t.Fatalf("正常执行的恢复资格被拒绝污染: %v %v", needs, err)
			}
		})
	}
}

func TestAuthorizeRefusalSurvivesPersistenceFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worker.db")
	if err := CreateLedger(path); err != nil {
		t.Fatal(err)
	}
	w, err := openWorkerDB(path, NewObserver(""))
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	taskID, executionID := mustSessionID(t), mustSessionID(t)
	if err := w.Bind(taskID, executionID, "pi"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.db.Exec(`CREATE TRIGGER fail_refusal BEFORE INSERT ON meta
		WHEN NEW.key = 'start_refused' BEGIN SELECT RAISE(ABORT, 'test refusal failure'); END`); err != nil {
		t.Fatal(err)
	}
	reply := handleWorker(w, mustSessionID(t), ipcMessage{
		Type: "authorize", TaskID: taskID, ExecutionID: executionID,
		QueueExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
	})
	if reply.OK || !reply.Refused || reply.Code != "invalid_target" || w.intent || w.observer.Starts() != 0 {
		t.Fatalf("写库失败把拒绝变成普通错误或启动: %+v", reply)
	}
}

func TestLedgerRecoveryRequiresOutstandingStartRequest(t *testing.T) {
	for _, tc := range []struct {
		name    string
		meta    map[string]string
		pending bool
		want    bool
	}{
		{name: "empty"},
		{name: "prepared", meta: map[string]string{"execution_id": "bound"}},
		{name: "waiting", meta: map[string]string{"start_nonce": "requested"}, want: true},
		{name: "refused", meta: map[string]string{"start_nonce": "requested", "start_refused": "conflict"}},
		{name: "cancelled", meta: map[string]string{"start_nonce": "requested", "start_cancelled": "1"}},
		{name: "intent", meta: map[string]string{"start_intent": "1"}, want: true},
		{name: "intent_before_refusal", meta: map[string]string{"start_intent": "1", "start_refused": "invalid_target"}, want: true},
		{name: "pending_before_refusal", meta: map[string]string{"start_refused": "conflict"}, pending: true, want: true},
		{name: "delivered", meta: map[string]string{"start_intent": "1", "result_delivered": "1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "worker.db")
			if err := CreateLedger(path); err != nil {
				t.Fatal(err)
			}
			db, err := sql.Open("sqlite", sqliteDSN(path))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			for key, value := range tc.meta {
				if _, err := db.Exec(`INSERT INTO meta (key, value) VALUES (?, ?)`, key, value); err != nil {
					t.Fatal(err)
				}
			}
			if tc.pending {
				if _, err := db.Exec(`INSERT INTO outbox (event_id, kind, payload) VALUES (?, ?, '{}')`, mustSessionID(t), protocol.ReportNeedsVerification); err != nil {
					t.Fatal(err)
				}
			}
			needs, err := LedgerNeedsWorker(path)
			if err != nil || needs != tc.want {
				t.Fatalf("恢复资格 = %v，期望 %v: %v", needs, tc.want, err)
			}
		})
	}
}

func TestRejectStartOnlyRecordsCurrentUnstartedExecution(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worker.db")
	if err := CreateLedger(path); err != nil {
		t.Fatal(err)
	}
	w, err := openWorkerDB(path, NewObserver(""))
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	taskID, executionID := mustSessionID(t), mustSessionID(t)
	if err := w.RejectStart(taskID, executionID, "conflict"); err == nil {
		t.Fatal("未绑定的执行接受了拒绝记录")
	}
	if err := w.Bind(taskID, executionID, "pi"); err != nil {
		t.Fatal(err)
	}
	for _, ids := range [][2]string{{taskID, mustSessionID(t)}, {mustSessionID(t), executionID}} {
		if err := w.RejectStart(ids[0], ids[1], "conflict"); err == nil {
			t.Fatal("其他执行的拒绝被记录")
		}
	}
	var count int
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM meta WHERE key = 'start_refused'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("身份不匹配污染账本: %d %v", count, err)
	}
	if _, err := w.Arm(taskID, executionID); err != nil {
		t.Fatal(err)
	}
	if err := w.RejectStart(taskID, executionID, "conflict"); err != nil {
		t.Fatal(err)
	}
	needs, err := LedgerNeedsWorker(path)
	if err != nil || needs {
		t.Fatalf("中心拒绝后仍会恢复: %v %v", needs, err)
	}
	w.intent = true
	if err := w.RejectStart(taskID, executionID, "revoked"); err != nil {
		t.Fatal(err)
	}
	var code string
	if err := w.db.QueryRow(`SELECT value FROM meta WHERE key = 'start_refused'`).Scan(&code); err != nil || code != "conflict" {
		t.Fatalf("晚到的拒绝覆盖了启动事实: %s %v", code, err)
	}
}
