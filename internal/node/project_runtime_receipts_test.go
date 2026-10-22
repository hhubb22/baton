package node

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/monotime"
	"baton/internal/protocol"

	"github.com/coder/websocket"
)

func receiptManager(t *testing.T, dir string) *projectRuntimeManager {
	t.Helper()
	if dir == "" {
		dir = t.TempDir()
	}
	ledger, err := OpenLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ledger.Close() })
	m, err := newProjectRuntimeManager(context.Background(), ledger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.close)
	return m
}

// reply=false 模拟接收操作后回包丢失，连接仍可继续传输。
func receiptConnection(t *testing.T, m *projectRuntimeManager, reply func(context.Context, protocol.ProjectRuntimeRequest) (protocol.ProjectRuntimeResult, bool)) <-chan protocol.ProjectRuntimeRequest {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	requests := make(chan protocol.ProjectRuntimeRequest, 256)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		for {
			_, raw, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var frame struct {
				Envelope protocol.Envelope `json:"envelope"`
			}
			var req protocol.ProjectRuntimeRequest
			if json.Unmarshal(raw, &frame) != nil || json.Unmarshal(frame.Envelope.Body, &req) != nil {
				return
			}
			select {
			case requests <- req:
			case <-ctx.Done():
				return
			}
			result, send := reply(ctx, req)
			if !send {
				continue
			}
			result.Type = protocol.BodyProjectRuntimeResult
			body, _ := json.Marshal(result)
			raw, _ = json.Marshal(protocol.Envelope{CorrelationID: frame.Envelope.MessageID, Body: body})
			if ws.Write(ctx, websocket.MessageText, raw) != nil {
				return
			}
		}
	}))
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	loop := newRuntimeRPC(newWSWriter(ws))
	m.setLoop(loop)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, raw, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var env protocol.Envelope
			if json.Unmarshal(raw, &env) == nil {
				loop.onReply(env)
			}
		}
	}()
	t.Cleanup(func() { cancel(); ws.CloseNow(); <-done; server.Close() })
	return requests
}

func awaitReceiptCondition(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("receipt condition did not become true")
		}
		time.Sleep(time.Millisecond)
	}
}

func syntheticProjectProcess(m *projectRuntimeManager, command protocol.ProjectRunCommand) *projectRuntimeProcess {
	p := &projectRuntimeProcess{command: command, wake: make(chan struct{}, 1), done: make(chan struct{}), finished: make(chan struct{}), ctx: m.ctx, stop: func() {}, started: true}
	now, _ := m.clock.Mono()
	p.lastRenew.Store(int64(now))
	m.mu.Lock()
	m.runs[command.RunID] = p
	m.mu.Unlock()
	return p
}

func TestProjectWakeReceiptBoundedQueueAndIdempotentNotifications(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := &projectRuntimeManager{ctx: ctx, clock: monotime.NewClock(), leaseDeadline: time.Minute, runs: map[string]*projectRuntimeProcess{}, wakeReceipts: make(chan projectWakeReceipt, 64), loop: &runtimeRPC{}}
	command := projectCommand()
	p := syntheticProjectProcess(m, command)
	thread := projectCommand().RunID
	changed := make(chan struct{})
	p.threadWaits = map[string]*projectThreadWait{thread: {version: 1, observed: 1, changed: changed}}
	command.Type = protocol.BodyProjectRunWake
	command.InputIDs = []int64{1}
	command.ThreadUpdates = []protocol.ProjectThreadUpdate{{ThreadID: thread, Version: 2}}
	m.command(command)
	if len(m.wakeReceipts) != 0 || len(p.wake) != 1 || p.threadWaits[thread].version != 2 {
		t.Fatal("old center must still notify locally without a receipt")
	}
	select {
	case <-changed:
	default:
		t.Fatal("thread waiter was not notified")
	}
	changed = p.threadWaits[thread].changed
	m.controlReceipts = true
	for i := range 65 {
		command.InputIDs = []int64{int64(i + 1)}
		m.command(command)
	}
	if len(m.wakeReceipts) != 64 || len(p.wake) != 1 || p.threadWaits[thread].changed != changed {
		t.Fatal("duplicate notifications must coalesce and receipt queue must be bounded")
	}
	<-m.wakeReceipts
	command.InputIDs = []int64{65}
	m.command(command)
	for range 63 {
		<-m.wakeReceipts
	}
	if got := <-m.wakeReceipts; len(got.command.InputIDs) != 1 || got.command.InputIDs[0] != 65 {
		t.Fatalf("dropped receipt could not be retried: %+v", got)
	}
	command.ThreadUpdates = []protocol.ProjectThreadUpdate{{ThreadID: thread, Version: 3}}
	for _, ids := range [][]int64{{0}, {-1}, make([]int64, 33)} {
		command.InputIDs = ids
		m.command(command)
	}
	command.InputIDs = []int64{70}
	command.LeaseEpoch++
	m.command(command)
	command.LeaseEpoch--
	command.RunID = projectCommand().RunID
	m.command(command)
	if len(m.wakeReceipts) != 0 || p.threadWaits[thread].version != 2 || p.threadWaits[thread].changed != changed {
		t.Fatal("invalid inputs or stale run/epoch changed the thread wait or were acknowledged")
	}
}

func TestProjectWakeReceiptCapabilityAndCloseCancelsLostReply(t *testing.T) {
	m := receiptManager(t, "")
	var capability atomic.Bool
	var drop atomic.Bool
	requests := receiptConnection(t, m, func(_ context.Context, req protocol.ProjectRuntimeRequest) (protocol.ProjectRuntimeResult, bool) {
		if req.Operation == "wake_received" && drop.Load() {
			return protocol.ProjectRuntimeResult{}, false
		}
		data := json.RawMessage(`{"lease_seconds":60}`)
		if capability.Load() {
			data = json.RawMessage(`{"control_receipts":1}`)
		}
		return protocol.ProjectRuntimeResult{OK: true, Data: data}, true
	})
	command := projectCommand()
	p := syntheticProjectProcess(m, command)
	m.report(command, "renew", "")
	command.Type, command.InputIDs = protocol.BodyProjectRunWake, []int64{4}
	sendProjectCommand(m, command)
	if len(p.wake) != 1 {
		t.Fatal("old center wake lost")
	}
	m.mu.Lock()
	if m.controlReceipts {
		t.Fatal("missing capability was treated as supported")
	}
	m.mu.Unlock()
	capability.Store(true)
	m.report(command, "started", "")
	drop.Store(true)
	sendProjectCommand(m, command)
	first := waitProjectRequest(t, requests, "wake_received")
	if string(first.Payload) != `{"input_ids":[4]}` {
		t.Fatalf("receipt payload: %s", first.Payload)
	}
	// 丢回包的在途请求与后续输入均由单 worker 执行，关闭会取消它们。
	command.InputIDs = []int64{9}
	sendProjectCommand(m, command)
	closed := make(chan struct{})
	go func() { m.close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("close did not cancel/join the blocked receipt worker")
	}
	m.loop.mu.Lock()
	waiters := len(m.loop.waiters)
	m.loop.mu.Unlock()
	if waiters != 0 {
		t.Fatalf("receipt RPC waiter leaked: %d", waiters)
	}
}

func TestProjectWakeReceiptNewInputsAndConnectionCapability(t *testing.T) {
	m := receiptManager(t, "")
	requests := receiptConnection(t, m, func(context.Context, protocol.ProjectRuntimeRequest) (protocol.ProjectRuntimeResult, bool) {
		return protocol.ProjectRuntimeResult{OK: true, Data: json.RawMessage(`{"control_receipts":1}`)}, true
	})
	command := projectCommand()
	p := syntheticProjectProcess(m, command)
	m.report(command, "renew", "")
	command.Type = protocol.BodyProjectRunWake
	for _, id := range []int64{100, 100, 2, 101} {
		command.InputIDs = []int64{id}
		sendProjectCommand(m, command)
		req := waitProjectRequest(t, requests, "wake_received")
		var payload struct {
			InputIDs []int64 `json:"input_ids"`
		}
		if json.Unmarshal(req.Payload, &payload) != nil || len(payload.InputIDs) != 1 || payload.InputIDs[0] != id || req.RunID != command.RunID || req.LeaseEpoch != command.LeaseEpoch {
			t.Fatalf("receipt confused input identities: %+v", req)
		}
	}
	oldLoop := m.loop
	m.setLoop(nil)
	m.setLoop(oldLoop)
	m.mu.Lock()
	capability := m.controlReceipts
	m.mu.Unlock()
	if capability {
		t.Fatal("reconnected center inherited the previous capability")
	}
	// 排队的旧连接回执不能借用新连接的能力。
	m.sendWakeReceipt(projectWakeReceipt{command: command, loop: &runtimeRPC{}})
	// 即便同一 run ID 被错误复用，epoch 变化也必须使旧回执失效。
	p.command.LeaseEpoch++
	m.mu.Lock()
	m.controlReceipts = true
	m.mu.Unlock()
	m.sendWakeReceipt(projectWakeReceipt{command: command, loop: oldLoop})
	result, terminate := m.runtimeRequest(context.Background(), p, protocol.ProjectRuntimeRequest{Operation: "wake_received", Payload: json.RawMessage(`{"input_ids":[1]}`)})
	if result.Code != "invalid_request" || terminate {
		t.Fatalf("Runtime IPC obtained node receipt authority: %+v", result)
	}
	select {
	case req := <-requests:
		t.Fatalf("stale receipt or forbidden IPC reached center: %+v", req)
	default:
	}
}
