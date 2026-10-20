package session

import (
	"database/sql"
	"encoding/json"
	"strings"
	"testing"

	"baton/internal/agent"
	"baton/internal/task"
)

func deferredCommitFailure(t *testing.T, w *workerDB, stop bool) *sql.DB {
	t.Helper()
	var seq int
	var name, path string
	if err := w.db.QueryRow(`PRAGMA database_list`).Scan(&seq, &name, &path); err != nil {
		t.Fatal(err)
	}
	if err := w.db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", sqliteDSN(path)+"&_pragma=foreign_keys(ON)")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	w.db = db
	execLedger(t, w, `CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
		CREATE TABLE commit_child(parent_id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`)
	trigger := `CREATE TRIGGER fail_commit AFTER INSERT ON outbox WHEN NEW.kind='result'
		BEGIN INSERT INTO commit_child(parent_id) VALUES(1); END`
	if stop {
		trigger = `CREATE TRIGGER fail_commit AFTER INSERT ON meta WHEN NEW.key='stop_output'
			BEGIN INSERT INTO commit_child(parent_id) VALUES(1); END`
	}
	execLedger(t, w, trigger)
	reader, err := sql.Open("sqlite", sqliteDSN(path)+"&mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	reader.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = reader.Close() })
	return reader
}

func committedCount(t *testing.T, db *sql.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestDeferredForeignKeyCommitRetainsDrainedOutput(t *testing.T) {
	w, a, sid := reliabilityWorker(t)
	reader := deferredCommitFailure(t, w, false)
	a.outputs = []Output{{Final: reliableFinal, Exited: true, Raw: json.RawMessage(`{"event":"final"}`)}}
	for range 2 {
		err := w.checkDeadline(sid)
		if err == nil || !strings.Contains(err.Error(), "FOREIGN KEY") {
			t.Fatalf("failed deferred commit was accepted or left an active transaction: %v", err)
		}
		if len(w.pendingOutputs) != 1 || w.pendingOutputID == "" || a.drains != 1 {
			t.Fatal("failed commit consumed drained output")
		}
		if committedCount(t, reader, `SELECT COUNT(*) FROM outbox WHERE kind='result'`) != 0 ||
			committedCount(t, reader, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`) != 0 ||
			committedCount(t, reader, `SELECT COUNT(*) FROM execution_log WHERE kind='output_commit' AND body=?`, w.pendingOutputID) != 0 {
			t.Fatal("independent connection observed partial output transaction")
		}
	}
	execLedger(t, w, `DROP TRIGGER fail_commit`)
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	if len(w.pendingOutputs) != 0 || a.drains != 1 || committedCount(t, reader, `SELECT COUNT(*) FROM outbox WHERE kind='result'`) != 1 ||
		committedCount(t, reader, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`) != 1 {
		t.Fatal("retry did not commit exactly one retained output")
	}
}

func TestDeferredForeignKeyCommitRetainsPendingStopOutput(t *testing.T) {
	w, _, _ := reliabilityWorker(t)
	reader := deferredCommitFailure(t, w, true)
	output := commandStopOutput(t).Final
	w.pendingStopOutput = output
	for range 2 {
		err := w.flushStopOutputLocked()
		if err == nil || !strings.Contains(err.Error(), "FOREIGN KEY") {
			t.Fatalf("failed stop commit was accepted or left an active transaction: %v", err)
		}
		if w.pendingStopOutput != output {
			t.Fatal("failed stop commit discarded pending output")
		}
		if committedCount(t, reader, `SELECT COUNT(*) FROM meta WHERE key='stop_output'`) != 0 ||
			committedCount(t, reader, `SELECT COUNT(*) FROM execution_log WHERE kind='output'`) != 0 {
			t.Fatal("independent connection observed uncommitted stop output")
		}
	}
	execLedger(t, w, `DROP TRIGGER fail_commit`)
	if err := w.flushStopOutputLocked(); err != nil {
		t.Fatal(err)
	}
	if w.pendingStopOutput != "" || committedCount(t, reader, `SELECT COUNT(*) FROM meta WHERE key='stop_output' AND value=?`, output) != 1 ||
		committedCount(t, reader, `SELECT COUNT(*) FROM execution_log WHERE kind='output'`) != 1 {
		t.Fatal("retry did not commit exactly one stop output")
	}
}

func TestRestoredWaitingForChildrenClearsUncertainty(t *testing.T) {
	w, _, sid := reliabilityWorker(t)
	w = reopenReliabilityWorker(t, w)
	if !w.recoveredUncertain {
		t.Fatal("fixture did not restore uncertainty")
	}
	a := &drainingStub{nativeStub: &nativeStub{outputs: []Output{{WaitingForChildren: true}}}}
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
	if err := w.restoreAdapter(sid); err != nil {
		t.Fatal(err)
	}
	if err := w.recover(sid); err != nil {
		t.Fatal(err)
	}
	if w.recoveredUncertain || w.uncertainCode != "" || !w.inputResolved || countLedger(t, w, `SELECT COUNT(*) FROM outbox WHERE kind='needs_verification'`) != 0 {
		t.Fatal("trusted restored wait remained uncertain")
	}
	if err := w.ReceiveChild(sid, childInput(t, w, sid), false); err != nil {
		t.Fatal(err)
	}
	if a.deliveries != 1 || w.generation != 2 {
		t.Fatal("restored wait blocked child delivery")
	}
}

func TestWaitingReceiptReplayClearsUncertaintyAfterReadFailure(t *testing.T) {
	w, _, sid := reliabilityWorker(t)
	w = reopenReliabilityWorker(t, w)
	a := &drainingStub{nativeStub: &nativeStub{outputs: []Output{{WaitingForChildren: true, Raw: json.RawMessage(`{"event":"waiting"}`)}}}}
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
	fault := injectCommitFault(t, w, true)
	fault.armed.Store(true)
	if err := w.restoreAdapter(sid); err == nil {
		t.Fatal("postcommit read failure was swallowed")
	}
	if len(w.pendingOutputs) != 1 || !w.recoveredUncertain {
		t.Fatal("fixture did not retain wait after failed state refresh")
	}
	// Receipt replay reconstructs trust from the committed transaction even when
	// the replay call carries no fresh Adapter observation.
	if err := w.saveOutputLocked(sid, "", Output{}, w.pendingOutputID, true); err != nil {
		t.Fatal(err)
	}
	if w.recoveredUncertain {
		t.Fatal("receipt replay did not restore the committed trusted wait")
	}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	if err := w.recover(sid); err != nil {
		t.Fatal(err)
	}
	if w.recoveredUncertain || w.uncertainCode != "" || len(w.pendingOutputs) != 0 || a.drains != 1 ||
		countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`) != 1 ||
		countLedger(t, w, `SELECT COUNT(*) FROM outbox WHERE kind='needs_verification'`) != 0 {
		t.Fatal("waiting receipt replay lost trusted state or duplicated output")
	}
	if err := w.ReceiveChild(sid, childInput(t, w, sid), false); err != nil {
		t.Fatal(err)
	}
	if a.deliveries != 1 {
		t.Fatal("receipt replay left child delivery blocked")
	}
}

func TestUncertainWaitingDoesNotClearRecoveryFlag(t *testing.T) {
	w, a, sid := reliabilityWorker(t)
	w.recoveredUncertain, w.uncertainCode = true, task.CodeUncertainWorker
	a.outputs = []Output{{WaitingForChildren: true, Uncertain: true}}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	if !w.recoveredUncertain || w.uncertainCode != task.CodeUncertainWorker {
		t.Fatal("uncertain wait cleared recovery uncertainty")
	}
}

func TestDeferredForeignKeyCommitRetainsCancelledDrainedOutput(t *testing.T) {
	w, a, sid := reliabilityWorker(t)
	if _, err := w.Stop(sid, task.StatusCancelled); err != nil {
		t.Fatal(err)
	}
	reader := deferredCommitFailure(t, w, true)
	out := commandStopOutput(t)
	out.Raw = json.RawMessage(`{"event":"stopped"}`)
	a.outputs = []Output{out}
	if err := w.checkDeadline(sid); err == nil || !strings.Contains(err.Error(), "FOREIGN KEY") {
		t.Fatalf("cancelled deferred commit was accepted: %v", err)
	}
	if w.pendingStopOutput != out.Final || len(w.pendingOutputs) != 1 || a.drains != 2 {
		t.Fatal("cancelled commit failure consumed output")
	}
	if committedCount(t, reader, `SELECT COUNT(*) FROM meta WHERE key='stop_output'`) != 0 || committedCount(t, reader, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`) != 0 {
		t.Fatal("cancelled output escaped failed commit")
	}
	execLedger(t, w, `DROP TRIGGER fail_commit`)
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	if w.pendingStopOutput != "" || len(w.pendingOutputs) != 0 || !w.cancelled || a.drains != 2 {
		t.Fatal("cancelled retry lost state")
	}
	assertStoppedCommandOutput(t, w, sid, task.StatusCancelled)
}

func TestStopOutputCommitAcknowledgementLossUsesCommittedState(t *testing.T) {
	w, _, _ := reliabilityWorker(t)
	fault := injectCommitFault(t, w, false)
	output := commandStopOutput(t).Final
	w.pendingStopOutput = output
	fault.armed.Store(true)
	if err := w.flushStopOutputLocked(); err != nil {
		t.Fatal(err)
	}
	if w.pendingStopOutput != "" {
		t.Fatal("committed stop output was not confirmed")
	}
	w.pendingStopOutput = output
	if err := w.flushStopOutputLocked(); err != nil {
		t.Fatal(err)
	}
	if countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='output'`) != 1 {
		t.Fatal("stop acknowledgement loss duplicated output")
	}
}

func TestOldWaitingReceiptDoesNotClearNewRecoveryUncertainty(t *testing.T) {
	w, a, sid := reliabilityWorker(t)
	a.outputs = []Output{{WaitingForChildren: true}}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	w = reopenReliabilityWorker(t, w)
	restored := &drainingStub{nativeStub: &nativeStub{outputs: []Output{{Raw: json.RawMessage(`{"event":"history_unavailable"}`)}}}}
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return restored, nil }
	if err := w.restoreAdapter(sid); err != nil {
		t.Fatal(err)
	}
	if !w.recoveredUncertain {
		t.Fatal("a prior process's trusted wait cleared a new recovery without fresh evidence")
	}
	if err := w.recover(sid); err != nil {
		t.Fatal(err)
	}
	if countLedger(t, w, `SELECT COUNT(*) FROM outbox WHERE kind='needs_verification'`) != 1 {
		t.Fatal("new unverified recovery lost its verification report")
	}
}

func TestOutputRollbackFailureDiscardsActiveConnection(t *testing.T) {
	for _, stop := range []bool{false, true} {
		t.Run(map[bool]string{false: "result", true: "stop"}[stop], func(t *testing.T) {
			w, a, sid := reliabilityWorker(t)
			reader := deferredCommitFailure(t, w, stop)
			execLedger(t, w, `DROP TRIGGER fail_commit`)
			fault := injectCommitFault(t, w, false)
			if stop {
				w.pendingStopOutput = commandStopOutput(t).Final
				execLedger(t, w, `CREATE TRIGGER fail_write BEFORE INSERT ON execution_log WHEN NEW.kind='output'
    BEGIN SELECT RAISE(ABORT,'fixture output write failed'); END`)
			} else {
				a.outputs = []Output{{Final: reliableFinal, Exited: true, Raw: json.RawMessage(`{"event":"final"}`)}}
				execLedger(t, w, `CREATE TRIGGER fail_write BEFORE INSERT ON outbox WHEN NEW.kind='result'
    BEGIN SELECT RAISE(ABORT,'fixture result write failed'); END`)
			}
			fault.failRollback.Store(true)
			var err error
			if stop {
				err = w.flushStopOutputLocked()
			} else {
				err = w.checkDeadline(sid)
			}
			if err == nil || fault.failRollback.Load() {
				t.Fatalf("fixture did not fail write and rollback: %v", err)
			}
			if committedCount(t, reader, `SELECT COUNT(*) FROM meta WHERE key='stop_output'`) != 0 || committedCount(t, reader, `SELECT COUNT(*) FROM outbox WHERE kind='result'`) != 0 || committedCount(t, reader, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`) != 0 {
				t.Fatal("failed rollback left visible output")
			}
			tx, err := w.db.Begin()
			if err != nil {
				t.Fatalf("failed rollback connection was recycled: %v", err)
			}
			if err := tx.Rollback(); err != nil {
				t.Fatal(err)
			}
			if stop && w.pendingStopOutput == "" || !stop && len(w.pendingOutputs) != 1 {
				t.Fatal("failed rollback consumed pending output")
			}
			execLedger(t, w, `DROP TRIGGER fail_write`)
			if stop {
				err = w.flushStopOutputLocked()
			} else {
				err = w.checkDeadline(sid)
			}
			if err != nil {
				t.Fatal(err)
			}
			if stop && w.pendingStopOutput != "" || !stop && len(w.pendingOutputs) != 0 {
				t.Fatal("retry did not commit retained output")
			}
		})
	}
}

func TestReceiptReplayRollbackFailureDiscardsConnection(t *testing.T) {
	w, a, sid := reliabilityWorker(t)
	fault := injectCommitFault(t, w, true)
	a.outputs = []Output{{Final: reliableFinal, Exited: true}}
	fault.armed.Store(true)
	if err := w.checkDeadline(sid); err == nil {
		t.Fatal("postcommit read failure swallowed")
	}
	fault.failRollback.Store(true)
	if err := w.checkDeadline(sid); err == nil || !strings.Contains(err.Error(), "rollback") {
		t.Fatalf("receipt rollback error swallowed: %v", err)
	}
	if len(w.pendingOutputs) != 1 {
		t.Fatal("failed receipt rollback consumed pending output")
	}
	tx, err := w.db.Begin()
	if err != nil {
		t.Fatalf("receipt rollback left an active transaction: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	if len(w.pendingOutputs) != 0 || countLedger(t, w, `SELECT COUNT(*) FROM outbox WHERE kind='result'`) != 1 || countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='output'`) != 1 {
		t.Fatal("receipt retry duplicated or lost committed output")
	}
}
