package node

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"baton/internal/protocol"
)

func TestProjectReceiptCloseCancelsBothWorkersWaitingForWriter(t *testing.T) {
	m := receiptManager(t, "")
	requests := receiptConnection(t, m, func(context.Context, protocol.ProjectRuntimeRequest) (protocol.ProjectRuntimeResult, bool) {
		return protocol.ProjectRuntimeResult{OK: true, Data: json.RawMessage(`{"control_receipts":1}`)}, true
	})
	command := projectCommand()
	syntheticProjectProcess(m, command)
	if result := m.report(command, "started", ""); !result.OK {
		t.Fatal(result)
	}
	waitProjectRequest(t, requests, "started")
	writer := m.loop.writer
	writer.writeSlot <- struct{}{}
	defer func() { <-writer.writeSlot }()
	command.Type, command.InputIDs = protocol.BodyProjectRunWake, []int64{1}
	sendProjectCommand(m, command)
	stopped := projectCommand()
	stopped.Type = protocol.BodyProjectRunStop
	m.command(stopped)
	awaitReceiptCondition(t, func() bool {
		m.loop.mu.Lock()
		defer m.loop.mu.Unlock()
		return len(m.loop.waiters) == 2
	})
	closed := make(chan struct{})
	go func() { m.close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("manager.close waited for another sender to release writer admission")
	}
	m.loop.mu.Lock()
	waiters := len(m.loop.waiters)
	m.loop.mu.Unlock()
	if waiters != 0 || len(writer.writeSlot) != 1 {
		t.Fatalf("worker shutdown leaked waiters or released another sender's slot: waiters=%d slot=%d", waiters, len(writer.writeSlot))
	}
	var complete, acked, attempts int
	if err := m.ledger.db.QueryRow(`SELECT cleanup_complete,cleanup_acked,cleanup_attempts FROM project_runtime_runs WHERE run_id=?`, stopped.RunID).Scan(&complete, &acked, &attempts); err != nil || complete != 1 || acked != 0 || attempts != 1 {
		t.Fatalf("canceled cleanup receipt lost its durable retry: complete=%d acked=%d attempts=%d err=%v", complete, acked, attempts, err)
	}
	select {
	case req := <-requests:
		t.Fatalf("canceled receipt was sent despite blocked writer: %+v", req)
	default:
	}
}

func TestProjectReceiptDeadlineIncludesWriterAdmission(t *testing.T) {
	m := receiptManager(t, "")
	requests := receiptConnection(t, m, func(context.Context, protocol.ProjectRuntimeRequest) (protocol.ProjectRuntimeResult, bool) {
		return protocol.ProjectRuntimeResult{OK: true}, true
	})
	writer := m.loop.writer
	writer.writeSlot <- struct{}{}
	defer func() { <-writer.writeSlot }()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	done := make(chan protocol.ProjectRuntimeResult, 1)
	go func() { done <- m.reportContext(ctx, projectCommand(), "renew", "") }()
	select {
	case result := <-done:
		if result.OK || result.Code != "unavailable" || !errors.Is(ctx.Err(), context.DeadlineExceeded) {
			t.Fatalf("receipt waiting for writer admission: %+v, ctx=%v", result, ctx.Err())
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("receipt deadline did not bound writer admission")
	}
	m.loop.mu.Lock()
	waiters := len(m.loop.waiters)
	m.loop.mu.Unlock()
	if waiters != 0 {
		t.Fatalf("expired receipt left an RPC waiter: %d", waiters)
	}
	select {
	case req := <-requests:
		t.Fatalf("expired receipt reached center: %+v", req)
	default:
	}
}
