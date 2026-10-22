package session

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"baton/internal/agent"

	"modernc.org/sqlite"
)

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
	if c.fault.failRead.Load() && strings.Contains(query, "SELECT commit_token FROM thread_meta") && c.fault.failRead.Swap(false) {
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

func injectCommitFault(t *testing.T, w *ThreadWorker, loseRead bool) *commitFaultDriver {
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

func TestThreadOutputCommitAcknowledgementLoss(t *testing.T) {
	a := &threadFake{}
	w := newThreadTestWorker(t, nil, a)
	threadMessage(t, w, "first", "queue")
	fault := injectCommitFault(t, w, false)
	a.add(agent.Event{Kind: agent.EventReply, Content: "durable reply"}, agent.Event{Kind: agent.EventTurnEnded, Reason: agent.EndCompleted})
	fault.armed.Store(true)
	threadMust(t, w.Poll(context.Background()))
	if threadCount(t, w, "SELECT COUNT(*) FROM thread_replies") != 1 {
		t.Fatal("reply lost or duplicated")
	}
	threadMust(t, w.Poll(context.Background()))
	if threadCount(t, w, "SELECT COUNT(*) FROM thread_replies") != 1 {
		t.Fatal("reply repeated")
	}
}
func TestThreadOutputCommitRollbackRetriesBatch(t *testing.T) {
	a := &threadFake{}
	w := newThreadTestWorker(t, nil, a)
	threadMessage(t, w, "first", "queue")
	fault := injectCommitFault(t, w, false)
	fault.rollback = true
	fault.armed.Store(true)
	a.add(agent.Event{Kind: agent.EventReply, Content: "retry reply"}, agent.Event{Kind: agent.EventTurnEnded, Reason: agent.EndCompleted})
	if err := w.Poll(context.Background()); err == nil {
		t.Fatal("commit failure hidden")
	}
	if threadCount(t, w, "SELECT COUNT(*) FROM thread_replies") != 0 {
		t.Fatal("uncommitted reply visible")
	}
	threadMust(t, w.Poll(context.Background()))
	if threadCount(t, w, "SELECT COUNT(*) FROM thread_replies") != 1 {
		t.Fatal("reply lost or duplicated")
	}
	reports := threadReports(t, w)
	lastReply, lastEnd := -1, -1
	for i, r := range reports {
		if r.Kind == "reply" {
			lastReply = i
		}
		if r.Kind == "turn.ended" {
			lastEnd = i
		}
	}
	if lastReply < 0 || lastEnd <= lastReply {
		t.Fatal("turn ended before reply", reports)
	}
}
func TestThreadOutputRollbackDiscardsActiveConnection(t *testing.T) {
	w := newThreadTestWorker(t, nil, &threadFake{})
	fault := injectCommitFault(t, w, false)
	fault.failRollback.Store(true)
	conn, err := w.db.Conn(context.Background())
	threadMust(t, err)
	tx, err := conn.BeginTx(context.Background(), nil)
	threadMust(t, err)
	_, err = tx.Exec("UPDATE thread_meta SET status='unknown'")
	threadMust(t, err)
	if err := rollbackOutputTx(conn, tx); err == nil {
		t.Fatal("rollback failure hidden")
	}
	if threadState(t, w) != "idle" {
		t.Fatal("uncommitted state leaked")
	}
	threadMust(t, w.transaction(func(tx *sql.Tx) error { _, err := tx.Exec("UPDATE thread_meta SET status='stopped'"); return err }))
	if threadState(t, w) != "stopped" {
		t.Fatal("replacement connection unavailable")
	}
}
