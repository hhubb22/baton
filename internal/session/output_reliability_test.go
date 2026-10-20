package session

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"baton/internal/agent"
	"baton/internal/protocol"
	"baton/internal/task"

	"modernc.org/sqlite"
)

const reliableFinal = `{"status":"completed","summary":"saved","evidence_empty_reason":"fixture","artifacts_empty_reason":"fixture","error":null}`

type drainingStub struct {
	*nativeStub
	drains   int
	startErr error
}

func (a *drainingStub) Drain() []Output { a.drains++; return a.nativeStub.Drain() }
func (a *drainingStub) Start(ctx context.Context) error {
	a.starts++
	return a.startErr
}

func reliabilityWorker(t *testing.T) (*workerDB, *drainingStub, string) {
	t.Helper()
	w, _, sid := clockWorker(t, 60)
	a := &drainingStub{nativeStub: &nativeStub{}}
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
	if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
		t.Fatal(err)
	}
	return w, a, sid
}

func execLedger(t *testing.T, w *workerDB, query string, args ...any) {
	t.Helper()
	if _, err := w.db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

func countLedger(t *testing.T, w *workerDB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := w.db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func savedResult(t *testing.T, w *workerDB) protocol.ExecutionReport {
	t.Helper()
	r, err := w.resultLocked(w.db)
	if err != nil {
		t.Fatal(err)
	}
	if r == nil {
		t.Fatal("missing saved result")
	}
	return *r
}

func TestDrainBatchRetainsFailedItemAndSuffix(t *testing.T) {
	w, a, sid := reliabilityWorker(t)
	a.outputs = []Output{
		{Raw: json.RawMessage(`{"event":"first"}`)},
		{Raw: json.RawMessage(`{"event":"final"}`), Final: reliableFinal, Exited: true},
		{Raw: json.RawMessage(`{"event":"last"}`)},
	}
	execLedger(t, w, `CREATE TRIGGER fail_result BEFORE INSERT ON outbox WHEN NEW.kind='result'
		BEGIN SELECT RAISE(ABORT,'result write failed'); END`)
	for i := 0; i < 2; i++ {
		if err := w.checkDeadline(sid); err == nil {
			t.Fatal("write failure was swallowed")
		}
		if a.drains != 1 || len(w.pendingOutputs) != 2 || len(a.outputs) != 0 {
			t.Fatalf("lost batch or drained again: drains=%d pending=%d adapter=%d", a.drains, len(w.pendingOutputs), len(a.outputs))
		}
		if n := countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`); n != 1 {
			t.Fatalf("raw log escaped rollback: %d", n)
		}
		if n := countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='output'`); n != 0 {
			t.Fatalf("final escaped rollback: %d", n)
		}
	}
	a.outputs = []Output{{Raw: json.RawMessage(`{"event":"next_batch"}`)}}
	execLedger(t, w, `DROP TRIGGER fail_result`)
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	if a.drains != 1 || len(w.pendingOutputs) != 0 || len(a.outputs) != 1 {
		t.Fatal("new batch drained before finishing retained batch")
	}
	if r := savedResult(t, w); r.Summary != "saved" || !r.AgentStopped {
		t.Fatalf("wrong result: %+v", r)
	}
	if n := countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`); n != 3 {
		t.Fatalf("raw logs duplicated or lost: %d", n)
	}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	if a.drains != 2 || countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`) != 4 {
		t.Fatal("next batch not processed")
	}
	if countLedger(t, w, `SELECT COUNT(*) FROM outbox WHERE kind='result'`) != 1 || countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='output'`) != 1 {
		t.Fatal("duplicate result or final audit")
	}
}

func TestRecordExecutionDeduplicatesInsideTransaction(t *testing.T) {
	w, _, sid := reliabilityWorker(t)
	out := Output{Final: reliableFinal, Exited: true}
	if _, err := w.recordExecution(sid, "", out); err != nil {
		t.Fatal(err)
	}
	first := savedResult(t, w)
	if _, err := w.recordExecution(sid, "", Output{Final: "broken", Exited: true}); err != nil {
		t.Fatal(err)
	}
	if got := savedResult(t, w); got.EventID != first.EventID || got.Summary != first.Summary {
		t.Fatalf("duplicate replaced report: %+v", got)
	}
	if err := w.Ack(first.EventID); err != nil {
		t.Fatal(err)
	}
	if _, err := w.recordExecution(sid, "", out); err != nil {
		t.Fatal(err)
	}
	if n := countLedger(t, w, `SELECT COUNT(*) FROM outbox WHERE kind='result'`); n != 1 {
		t.Fatalf("duplicate result: %d", n)
	}
	if n := countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='output'`); n != 1 {
		t.Fatalf("duplicate final audit: %d", n)
	}
	w.resultDelivered, w.generation = false, 2
	if _, err := w.recordExecution(sid, "", out); err != nil {
		t.Fatal(err)
	}
	if got := savedResult(t, w); got.EventID == first.EventID || got.InputGeneration != 2 {
		t.Fatal("another generation reused the old report")
	}
	w.execution = mustSessionID(t)
	if _, err := w.recordExecution(sid, "", out); err != nil {
		t.Fatal(err)
	}
	if n := countLedger(t, w, `SELECT COUNT(*) FROM outbox WHERE kind='result'`); n != 3 {
		t.Fatalf("execution identity ignored: %d", n)
	}
}

func TestResultLookupFailureDoesNotInsertAnotherResult(t *testing.T) {
	w, a, sid := reliabilityWorker(t)
	execLedger(t, w, `INSERT INTO outbox(event_id,kind,payload) VALUES(?,'result','{')`, mustSessionID(t))
	a.outputs = []Output{{Final: reliableFinal, Exited: true, Raw: json.RawMessage(`{"event":"final"}`)}}
	if err := w.checkDeadline(sid); err == nil {
		t.Fatal("result lookup error treated as absence")
	}
	if len(w.pendingOutputs) != 1 || countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`) != 0 {
		t.Fatal("failed lookup consumed output")
	}
	execLedger(t, w, `DELETE FROM outbox WHERE payload='{'`)
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	if savedResult(t, w).Summary != "saved" {
		t.Fatal("retry lost final")
	}
}

func reopenReliabilityWorker(t *testing.T, w *workerDB) *workerDB {
	t.Helper()
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
	t.Cleanup(func() { _ = reopened.Close() })
	return reopened
}

func TestRestoredCompletionClearsUncertaintyAndDoesNotResubmit(t *testing.T) {
	w, _, sid := reliabilityWorker(t)
	w = reopenReliabilityWorker(t, w)
	if !w.recoveredUncertain {
		t.Fatal("fixture has no recovery uncertainty")
	}
	a := &drainingStub{nativeStub: &nativeStub{outputs: []Output{{Final: reliableFinal, Exited: true}}}}
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
	if err := w.restoreAdapter(sid); err != nil {
		t.Fatal(err)
	}
	if err := w.recover(sid); err != nil {
		t.Fatal(err)
	}
	if w.recoveredUncertain || !w.inputResolved || a.inputs != 0 {
		t.Fatal("completed recovery remained uncertain or resubmitted")
	}
	if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
		t.Fatal(err)
	}
	if a.inputs != 0 || countLedger(t, w, `SELECT COUNT(*) FROM outbox WHERE kind='needs_verification'`) != 0 {
		t.Fatal("recovery generated an input or verification report")
	}
	savedResult(t, w)
}

func TestSavedResultSurvivesAdapterRestoreFailure(t *testing.T) {
	for _, delivered := range []bool{false, true} {
		t.Run(map[bool]string{false: "pending", true: "acknowledged"}[delivered], func(t *testing.T) {
			w, _, sid := reliabilityWorker(t)
			if _, err := w.recordExecution(sid, "", Output{Final: reliableFinal, Exited: true}); err != nil {
				t.Fatal(err)
			}
			first := savedResult(t, w)
			if delivered {
				if err := w.Ack(first.EventID); err != nil {
					t.Fatal(err)
				}
			}
			w = reopenReliabilityWorker(t, w)
			a := &drainingStub{nativeStub: &nativeStub{}, startErr: agent.ErrHistoryMissing}
			w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
			if err := w.restoreAdapter(sid); err != nil {
				t.Fatal(err)
			}
			if err := w.recover(sid); err != nil {
				t.Fatal(err)
			}
			if w.recoveredUncertain || savedResult(t, w).EventID != first.EventID || w.resultDelivered != delivered {
				t.Fatal("adapter failure downgraded saved result")
			}
			if countLedger(t, w, `SELECT COUNT(*) FROM outbox WHERE kind='needs_verification'`) != 0 {
				t.Fatal("saved result generated verification report")
			}
		})
	}
}

func TestRecoveredCancelledOutputRetriesAtomically(t *testing.T) {
	w, _, sid := reliabilityWorker(t)
	if _, err := w.Stop(sid, task.StatusCancelled); err != nil {
		t.Fatal(err)
	}
	w = reopenReliabilityWorker(t, w)
	out := commandStopOutput(t)
	out.Raw = json.RawMessage(`{"event":"stopped"}`)
	a := &stopOutputStub{nativeStub: &nativeStub{outputs: []Output{out}}, settled: true}
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
	execLedger(t, w, `CREATE TRIGGER fail_stop_output BEFORE INSERT ON meta WHEN NEW.key='stop_output'
		BEGIN SELECT RAISE(ABORT,'stop output failure'); END`)
	if err := w.restoreAdapter(sid); err == nil {
		t.Fatal("stop output failure swallowed")
	}
	if !w.cancelled || w.pendingStopOutput == "" || len(w.pendingOutputs) != 1 {
		t.Fatal("cancelled output not retained")
	}
	if countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`) != 0 {
		t.Fatal("raw stop audit escaped rollback")
	}
	execLedger(t, w, `DROP TRIGGER fail_stop_output`)
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	if err := w.recover(sid); err != nil {
		t.Fatal(err)
	}
	assertStoppedCommandOutput(t, w, sid, task.StatusCancelled)
	if w.pendingStopOutput != "" || !w.cancelled || a.inputs != 0 {
		t.Fatal("retry lost cancellation or resubmitted")
	}
	if countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`) != 1 {
		t.Fatal("stop raw audit duplicated")
	}
}

// commitFaultDriver wraps real SQLite transactions; all statements still run
// against the ledger. It can lose the commit acknowledgement or one later read.
type commitFaultDriver struct {
	driver.Driver
	armed        atomic.Bool
	failRead     atomic.Bool
	failRollback atomic.Bool
	loseRead     bool
	rollback     bool
}

type commitFaultConn struct {
	driver.Conn
	fault *commitFaultDriver
}
type commitFaultTx struct {
	driver.Tx
	fault *commitFaultDriver
}

func (d *commitFaultDriver) Open(name string) (driver.Conn, error) {
	c, err := d.Driver.Open(name)
	if err != nil {
		return nil, err
	}
	return &commitFaultConn{Conn: c, fault: d}, nil
}
func (c *commitFaultConn) Begin() (driver.Tx, error) {
	tx, err := c.Conn.Begin()
	if err != nil {
		return nil, err
	}
	return &commitFaultTx{Tx: tx, fault: c.fault}, nil
}
func (c *commitFaultConn) Prepare(query string) (driver.Stmt, error) {
	if c.fault.failRead.Load() && strings.Contains(query, "SELECT payload FROM outbox") && c.fault.failRead.Swap(false) {
		return nil, errors.New("fixture postcommit read failure")
	}
	return c.Conn.Prepare(query)
}
func (tx *commitFaultTx) Commit() error {
	if tx.fault.rollback && tx.fault.armed.Swap(false) {
		if err := tx.Tx.Rollback(); err != nil {
			return err
		}
		return errors.New("fixture commit rolled back")
	}
	if err := tx.Tx.Commit(); err != nil {
		return err
	}
	if tx.fault.armed.Swap(false) {
		if tx.fault.loseRead {
			tx.fault.failRead.Store(true)
			return nil
		}
		return errors.New("fixture lost commit acknowledgement")
	}
	return nil
}

func (tx *commitFaultTx) Rollback() error {
	if tx.fault.failRollback.Swap(false) {
		return errors.New("fixture rollback left transaction active")
	}
	return tx.Tx.Rollback()
}

func injectCommitFault(t *testing.T, w *workerDB, loseRead bool) *commitFaultDriver {
	t.Helper()
	var seq int
	var label, path string
	if err := w.db.QueryRow(`PRAGMA database_list`).Scan(&seq, &label, &path); err != nil {
		t.Fatal(err)
	}
	fault := &commitFaultDriver{Driver: &sqlite.Driver{}, loseRead: loseRead}
	name := "session_commit_fault_" + mustSessionID(t)
	sql.Register(name, fault)
	if err := w.db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open(name, sqliteDSN(path))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	w.db = db
	return fault
}

func TestOutputCommitAcknowledgementLossUsesSavedResult(t *testing.T) {
	w, a, sid := reliabilityWorker(t)
	fault := injectCommitFault(t, w, false)
	a.outputs = []Output{{Final: reliableFinal, Exited: true, Raw: json.RawMessage(`{"event":"final"}`)}}
	fault.armed.Store(true)
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	first := savedResult(t, w)
	if len(w.pendingOutputs) != 0 {
		t.Fatal("confirmed commit not removed")
	}
	a.outputs = []Output{{Final: reliableFinal, Exited: true}}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	if savedResult(t, w).EventID != first.EventID || countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='output'`) != 1 {
		t.Fatal("commit acknowledgement loss duplicated final")
	}
}

func TestReceiptReplayRebuildsStateAfterPostcommitReadFailure(t *testing.T) {
	w, a, sid := reliabilityWorker(t)
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	// An unresolved native delivery makes a terminal output uncertain.
	execLedger(t, w, `INSERT INTO child_deliveries(delivery_id,child_task_id,payload,status,input_generation) VALUES('pending','child','{}','uncertain',1)`)
	execLedger(t, w, `INSERT INTO native_delivery_checks(delivery_id,queried) VALUES('pending',0)`)
	fault := injectCommitFault(t, w, true)
	a.outputs = []Output{{Final: reliableFinal, Exited: true, Raw: json.RawMessage(`{"event":"final"}`)}}
	fault.armed.Store(true)
	if err := w.checkDeadline(sid); err == nil {
		t.Fatal("postcommit read failure swallowed")
	}
	if len(w.pendingOutputs) != 1 || countLedger(t, w, `SELECT COUNT(*) FROM native_delivery_checks`) != 0 {
		t.Fatal("fixture did not commit before failed read")
	}
	first := savedResult(t, w)
	// Other output transactions must not overwrite this item's receipt.
	if _, err := w.recordExecution(sid, "", Output{}); err != nil {
		t.Fatal(err)
	}
	w.deliveryUncertain, w.inputResolved = false, false
	if err := w.saveOutputLocked(sid, "", w.pendingOutputs[0], w.pendingOutputID, true); err != nil {
		t.Fatal(err)
	}
	if !w.deliveryUncertain || !w.inputResolved {
		t.Fatal("receipt replay did not reconstruct committed state")
	}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	if !w.deliveryUncertain || !w.inputResolved || len(w.pendingOutputs) != 0 || a.drains != 2 {
		t.Fatal("receipt replay did not restore committed state")
	}
	if got := savedResult(t, w); got.EventID != first.EventID || got.Status != task.StatusNeedsVerification {
		t.Fatalf("receipt changed committed result: %+v", got)
	}
	if countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`) != 1 {
		t.Fatal("receipt replay duplicated raw audit")
	}
}

func TestOutputReceiptIndexMigratesExistingLedger(t *testing.T) {
	w, _, _ := reliabilityWorker(t)
	execLedger(t, w, `DROP INDEX execution_log_output_commit`)
	w = reopenReliabilityWorker(t, w)
	var id, parent, unused int
	var plan string
	if err := w.db.QueryRow(`EXPLAIN QUERY PLAN SELECT 1 FROM execution_log WHERE kind='output_commit' AND body=?`, "receipt").Scan(&id, &parent, &unused, &plan); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plan, "execution_log_output_commit") || !strings.Contains(plan, "SEARCH") {
		t.Fatalf("receipt lookup scans audit log: %s", plan)
	}
}

func TestOutputCommitFailureRetainsBatchUntilRetry(t *testing.T) {
	w, a, sid := reliabilityWorker(t)
	fault := injectCommitFault(t, w, false)
	fault.rollback = true
	fault.armed.Store(true)
	a.outputs = []Output{{Final: reliableFinal, Exited: true, Raw: json.RawMessage(`{"event":"final"}`)}}
	if err := w.checkDeadline(sid); err == nil {
		t.Fatal("rolled back commit treated as success")
	}
	if len(w.pendingOutputs) != 1 || countLedger(t, w, `SELECT COUNT(*) FROM outbox WHERE kind='result'`) != 0 || countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`) != 0 {
		t.Fatal("failed commit consumed output or left partial writes")
	}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	if len(w.pendingOutputs) != 0 || a.drains != 1 || savedResult(t, w).Summary != "saved" {
		t.Fatal("commit retry did not save retained batch")
	}
}

func TestSavedCompletionWinsAfterPostcommitReadFailure(t *testing.T) {
	w, a, sid := reliabilityWorker(t)
	fault := injectCommitFault(t, w, true)
	w.recoveredUncertain, w.inputResolved = true, false
	a.outputs = []Output{{Final: reliableFinal, Exited: true}}
	fault.armed.Store(true)
	if err := w.checkDeadline(sid); err == nil {
		t.Fatal("postcommit read failure swallowed")
	}
	if !w.recoveredUncertain || len(w.pendingOutputs) != 1 {
		t.Fatal("fixture did not retain stale recovery state")
	}
	if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
		t.Fatal(err)
	}
	if w.recoveredUncertain || !w.inputResolved || a.inputs != 1 || countLedger(t, w, `SELECT COUNT(*) FROM outbox WHERE kind='needs_verification'`) != 0 {
		t.Fatal("saved completion lost to stale in-memory uncertainty")
	}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	if len(w.pendingOutputs) != 0 || countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='output'`) != 1 {
		t.Fatal("receipt did not finish retained completion")
	}
}

func TestCancelledAfterDrainFailurePreservesOutput(t *testing.T) {
	w, a, sid := reliabilityWorker(t)
	out := commandStopOutput(t)
	out.Raw = json.RawMessage(`{"event":"final"}`)
	a.outputs = []Output{out}
	execLedger(t, w, `CREATE TRIGGER fail_result BEFORE INSERT ON outbox WHEN NEW.kind='result'
 BEGIN SELECT RAISE(ABORT,'result failed'); END`)
	if err := w.checkDeadline(sid); err == nil {
		t.Fatal("result failure swallowed")
	}
	if _, err := w.Stop(sid, task.StatusCancelled); err != nil {
		t.Fatal(err)
	}
	assertStoppedCommandOutput(t, w, sid, task.StatusCancelled)
	if !w.cancelled || len(w.pendingOutputs) != 0 || w.pendingStopOutput != "" || a.drains != 1 {
		t.Fatal("cancellation discarded or redrained pending output")
	}
	if countLedger(t, w, `SELECT COUNT(*) FROM execution_log WHERE kind='native_event'`) != 1 {
		t.Fatal("cancelled output audit duplicated")
	}
}

func TestPendingBatchBlocksChildGenerationAdvance(t *testing.T) {
	w, a, sid := reliabilityWorker(t)
	a.outputs = []Output{{WaitingForChildren: true}}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	execLedger(t, w, `CREATE TRIGGER fail_progress BEFORE INSERT ON execution_log WHEN NEW.kind='progress'
 BEGIN SELECT RAISE(ABORT,'progress failed'); END`)
	a.outputs = []Output{{Progress: []string{"pending progress"}, WaitingForChildren: true}}
	if err := w.checkDeadline(sid); err == nil {
		t.Fatal("progress failure swallowed")
	}
	delivery := childInput(t, w, sid)
	if err := w.ReceiveChild(sid, delivery, false); err == nil {
		t.Fatal("child generation advanced past pending output")
	}
	if w.generation != 1 || a.deliveries != 0 {
		t.Fatal("failed output was moved to another generation")
	}
	execLedger(t, w, `DROP TRIGGER fail_progress`)
	if err := w.ReceiveChild(sid, delivery, false); err != nil {
		t.Fatal(err)
	}
	if w.generation != 2 || a.deliveries != 1 || len(w.pendingOutputs) != 0 {
		t.Fatal("child did not advance after pending batch was committed")
	}
}

func TestSavedResultDeliveryDoesNotDependOnRestoredOutputWrites(t *testing.T) {
	w, _, sid := reliabilityWorker(t)
	if _, err := w.recordExecution(sid, "", Output{Final: reliableFinal, Exited: true}); err != nil {
		t.Fatal(err)
	}
	first := savedResult(t, w)
	w = reopenReliabilityWorker(t, w)
	a := &drainingStub{nativeStub: &nativeStub{outputs: []Output{{Raw: json.RawMessage(`{"event":"restore"}`)}}}}
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
	execLedger(t, w, `CREATE TRIGGER fail_raw BEFORE INSERT ON execution_log WHEN NEW.kind='native_event'
 BEGIN SELECT RAISE(ABORT,'raw audit failed'); END`)
	if err := w.restoreAdapter(sid); err != nil {
		t.Fatal(err)
	}
	if err := w.recover(sid); err != nil {
		t.Fatal(err)
	}
	if err := w.checkDeadline(sid); err == nil {
		t.Fatal("fixture did not fail output write")
	}
	reports, err := w.Pending()
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, r := range reports {
		if r.EventID == first.EventID {
			found = true
		}
	}
	if !found || w.recoveredUncertain || len(w.pendingOutputs) != 1 {
		t.Fatal("restored output failure blocked original result")
	}
}
