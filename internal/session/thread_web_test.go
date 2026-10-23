package session

import (
	"baton/internal/agent"
	"baton/internal/protocol"
	"context"
	"database/sql"
	"strings"
	"testing"
)

func TestThreadOutputIsScopedToTurn(t *testing.T) {
	a := &threadFake{resume: true}
	w := newThreadTestWorker(t, nil, a)
	threadMessage(t, w, "first", "queue")
	w.live.appendLiveLocked("previous turn", false)
	req := protocol.SessionRequest{Action: "output", OperationID: mustSessionID(t), SessionID: w.options.ThreadID}
	old := w.SessionRequest(t.Context(), req)
	a.add(agent.Event{Kind: agent.EventTurnEnded, Reason: agent.EndCompleted})
	threadMust(t, w.Poll(t.Context()))
	threadMessage(t, w, "second", "queue")
	w.live.appendLiveLocked("current turn", false)
	now := w.SessionRequest(t.Context(), req)
	if !now.OK || now.Text != "current turn" || now.Cursor == old.Cursor {
		t.Fatal(old, now)
	}
	req.Cursor = old.Cursor
	now = w.SessionRequest(t.Context(), req)
	if !now.Gap || strings.Contains(now.Text, "previous") {
		t.Fatal(now)
	}
}

func TestThreadResumeReportsActualStateAndRejectsUnknown(t *testing.T) {
	a := &threadFake{resume: true}
	w := newThreadTestWorker(t, nil, a)
	threadMust(t, w.transaction(func(tx *sql.Tx) error { return w.stateReport(tx, "stopped", "thread.stopped", "") }))
	threadMust(t, w.ResumeThread(context.Background()))
	if threadState(t, w) != "idle" || !a.configs[len(a.configs)-1].Restore {
		t.Fatal("resume did not restore")
	}
	reports := threadReports(t, w)
	if reports[len(reports)-1].Kind != "thread.resumed" {
		t.Fatal(reports)
	}
	threadMust(t, w.transaction(func(tx *sql.Tx) error { return w.stateReport(tx, "unknown", "thread.unknown", "") }))
	if err := w.ResumeThread(t.Context()); err == nil {
		t.Fatal("resumed an uncertain turn")
	}
}
