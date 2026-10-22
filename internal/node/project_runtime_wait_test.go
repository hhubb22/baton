package node

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"baton/internal/identity"
	"baton/internal/monotime"
	"baton/internal/protocol"
)

func threadWaitFixture(t *testing.T) (*projectRuntimeManager, *projectRuntimeProcess, *monotime.Manual, string) {
	t.Helper()
	clock := monotime.NewManual(time.Time{})
	p := &projectRuntimeProcess{command: projectCommand(), ctx: t.Context(), done: make(chan struct{}), wake: make(chan struct{}, 1), stop: func() {}, started: true}
	m := &projectRuntimeManager{ctx: t.Context(), clock: clock, leaseDeadline: time.Minute, runs: map[string]*projectRuntimeProcess{p.command.RunID: p}}
	id, _ := identity.NewUUID()
	rememberThread(t, p, "call-1", id, 7, 30_000, 0)
	return m, p, clock, id
}

func rememberThread(t *testing.T, p *projectRuntimeProcess, call, thread string, version, remaining int64, started time.Duration) {
	t.Helper()
	data, err := json.Marshal(map[string]any{"pending": true, "thread_id": thread, "version": version, "wait_remaining_ms": remaining, "wait_protocol": 1})
	if err != nil {
		t.Fatal(err)
	}
	if code := p.rememberThreadWait(protocol.ProjectRuntimeRequest{ToolCallID: call}, data, started); code != "" {
		t.Fatal(code)
	}
}

func pollThreadRequest(m *projectRuntimeManager, p *projectRuntimeProcess, id string, version int64, waitMS int) protocol.ProjectRuntimeResult {
	payload, _ := json.Marshal(map[string]any{"thread_id": id, "after_version": version, "wait_ms": waitMS})
	result, _ := m.runtimeRequest(p.ctx, p, protocol.ProjectRuntimeRequest{Operation: "poll_wake", Payload: payload})
	return result
}

func assertThreadWake(t *testing.T, result protocol.ProjectRuntimeResult, reason string, version int64) {
	t.Helper()
	var data struct {
		Reason  string `json:"reason"`
		Version int64  `json:"version"`
	}
	if !result.OK || json.Unmarshal(result.Data, &data) != nil || data.Reason != reason || data.Version != version {
		t.Fatalf("expected %s/%d, got %+v %s", reason, version, result, result.Data)
	}
}

func threadNotification(m *projectRuntimeManager, p *projectRuntimeProcess, id string, version int64) {
	command := p.command
	command.Type = protocol.BodyProjectRunWake
	command.ThreadUpdates = []protocol.ProjectThreadUpdate{{ThreadID: id, Version: version}}
	sendProjectCommand(m, command)
}

func TestThreadWaitCachesNotificationBeforeSubscribe(t *testing.T) {
	m, p, _, id := threadWaitFixture(t)
	threadNotification(m, p, id, 8)
	assertThreadWake(t, pollThreadRequest(m, p, id, 7, 25000), "thread_changed", 8)
}

func TestThreadWaitAcceptsOutOfOrderStateResponses(t *testing.T) {
	m, p, _, id := threadWaitFixture(t)
	rememberThread(t, p, "call-1", id, 8, 20_000, 0)
	rememberThread(t, p, "call-1", id, 7, 19_000, 0)
	assertThreadWake(t, pollThreadRequest(m, p, id, 8, 1), "timeout", 8)
	other, _ := identity.NewUUID()
	raw, _ := json.Marshal(map[string]any{"pending": true, "thread_id": other, "version": 1, "wait_remaining_ms": 1000, "wait_protocol": 1})
	if code := p.rememberThreadWait(protocol.ProjectRuntimeRequest{ToolCallID: "call-1"}, raw, 0); code != "unavailable" {
		t.Fatalf("同一工具调用被重新绑定到其他 Thread: %s", code)
	}
}

func TestThreadWaitLatePendingCannotRestoreCompletedBinding(t *testing.T) {
	_, p, _, id := threadWaitFixture(t)
	req := protocol.ProjectRuntimeRequest{Operation: "wait_tool", ToolCallID: "call-1"}
	slow := p.beginThreadCall(req.ToolCallID)
	fast := p.beginThreadCall(req.ToolCallID)
	final := protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, OK: true, Data: json.RawMessage(`{"kind":"tool_result","seq":2}`)}
	if got := p.finishThreadCall(fast, req, final, 0); !got.OK {
		t.Fatal(got)
	}
	pending, _ := json.Marshal(map[string]any{"pending": true, "thread_id": id, "version": 7, "wait_remaining_ms": 30000, "wait_protocol": 1})
	got := p.finishThreadCall(slow, req, protocol.ProjectRuntimeResult{OK: true, Data: pending}, 0)
	if !got.OK || string(got.Data) != string(final.Data) || len(p.threadWaits) != 0 || len(p.threadCalls) != 0 {
		t.Fatalf("迟到 pending 重建绑定或没有释放在途记录: %+v waits=%d calls=%d", got, len(p.threadWaits), len(p.threadCalls))
	}
	// 新的查询不复用已清理的响应缓存，失效来源仍然返回错误。
	late := p.beginThreadCall(req.ToolCallID)
	revoked := projectRuntimeFailure("lease_lost")
	if got := p.finishThreadCall(late, req, revoked, 0); got.Code != "lease_lost" || len(p.threadCalls) != 0 {
		t.Fatalf("完成缓存掩盖了来源失效: %+v", got)
	}
}

func TestThreadWaitBroadcastsToConcurrentSubscribers(t *testing.T) {
	m, p, _, id := threadWaitFixture(t)
	results := make(chan protocol.ProjectRuntimeResult, 2)
	for range 2 {
		go func() { results <- pollThreadRequest(m, p, id, 7, 25000) }()
	}
	threadNotification(m, p, id, 8)
	for range 2 {
		select {
		case result := <-results:
			assertThreadWake(t, result, "thread_changed", 8)
		case <-time.After(time.Second):
			t.Fatal("Thread 更新未广播到全部等待者")
		}
	}
}

func TestThreadWaitFiltersGenericDuplicateAndStaleNotifications(t *testing.T) {
	m, p, _, id := threadWaitFixture(t)
	other, _ := identity.NewUUID()
	threadNotification(m, p, other, 100)
	threadNotification(m, p, id, 7)
	threadNotification(m, p, id, 6)
	command := p.command
	command.Type = protocol.BodyProjectRunWake
	command.InputIDs = []int64{1}
	sendProjectCommand(m, command)
	command.LeaseEpoch--
	command.ThreadUpdates = []protocol.ProjectThreadUpdate{{ThreadID: id, Version: 100}}
	sendProjectCommand(m, command)
	assertThreadWake(t, pollThreadRequest(m, p, id, 7, 10), "timeout", 7)
	// 普通闲置通知仍可由原有协议消费。
	result, _ := m.runtimeRequest(t.Context(), p, protocol.ProjectRuntimeRequest{Operation: "poll_wake", Payload: json.RawMessage(`{"wait_ms":1}`)})
	if !result.OK || string(result.Data) != `{"wake":true}` {
		t.Fatalf("普通通知被 Thread 等待消耗: %+v", result)
	}
}

func TestThreadWaitValidatesBoundThreadAndVersion(t *testing.T) {
	m, p, _, id := threadWaitFixture(t)
	unbound, _ := identity.NewUUID()
	for _, payload := range []string{
		fmt.Sprintf(`{"thread_id":%q,"after_version":8,"wait_ms":1}`, id),
		fmt.Sprintf(`{"thread_id":%q,"after_version":-1,"wait_ms":1}`, id),
		fmt.Sprintf(`{"thread_id":%q,"wait_ms":1}`, id),
		fmt.Sprintf(`{"thread_id":%q,"after_version":0,"wait_ms":1}`, unbound),
		`{"thread_id":"invalid","after_version":0,"wait_ms":1}`,
		`{"after_version":0,"wait_ms":1}`,
		fmt.Sprintf(`{"thread_id":%q,"after_version":7,"wait_ms":25001}`, id),
	} {
		result, _ := m.runtimeRequest(t.Context(), p, protocol.ProjectRuntimeRequest{Operation: "poll_wake", Payload: json.RawMessage(payload)})
		if result.OK || result.Code != "invalid_request" {
			t.Fatalf("接受无效等待 %s: %+v", payload, result)
		}
	}
}

func TestThreadWaitCountsRoundTripAndSuspendAgainstBudget(t *testing.T) {
	m, p, clock, id := threadWaitFixture(t)
	// 中心返回 5 秒剩余预算；请求始于 0，响应耗时 2 秒。
	clock.Advance(2 * time.Second)
	rememberThread(t, p, "call-1", id, 7, 5_000, 0)
	clock.Suspend(4 * time.Second)
	assertThreadWake(t, pollThreadRequest(m, p, id, 7, 25000), "timeout", 7)
}

func TestThreadWaitRechecksSuspendWhileWaiting(t *testing.T) {
	m, p, clock, id := threadWaitFixture(t)
	rememberThread(t, p, "call-1", id, 7, 5_000, 0)
	result := make(chan protocol.ProjectRuntimeResult, 1)
	go func() { result <- pollThreadRequest(m, p, id, 7, 25000) }()
	clock.Suspend(6 * time.Second)
	select {
	case got := <-result:
		assertThreadWake(t, got, "timeout", 7)
	case <-time.After(2 * time.Second):
		t.Fatal("休眠后没有按包含休眠的预算结束等待")
	}
}

func TestThreadWaitStopsOnLeaseLossAndClockFailure(t *testing.T) {
	for _, failure := range []string{"lease", "clock"} {
		t.Run(failure, func(t *testing.T) {
			m, p, clock, id := threadWaitFixture(t)
			if failure == "lease" {
				clock.Suspend(time.Minute)
			} else {
				bad := &failingProjectRuntimeClock{Manual: clock}
				bad.failed.Store(true)
				m.clock = bad
			}
			result := pollThreadRequest(m, p, id, 7, 25000)
			if result.OK || result.Code != "lease_lost" {
				t.Fatalf("失效后仍然等待: %+v", result)
			}
		})
	}
}

func TestThreadWaitCancellationReleasesSubscriber(t *testing.T) {
	m, p, _, id := threadWaitFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	result := m.pollThreadWake(ctx, p, id, 7, 25*time.Second)
	if result.OK || result.Code != "unavailable" {
		t.Fatalf("取消后未结束: %+v", result)
	}
	// 后续订阅仍可收到通知，没有遗留的消费者取走信号。
	threadNotification(m, p, id, 8)
	assertThreadWake(t, pollThreadRequest(m, p, id, 7, 25000), "thread_changed", 8)
}

func TestThreadBindingsBoundedAndReleasedAfterToolResult(t *testing.T) {
	_, p, _, id := threadWaitFixture(t)
	for i := 1; i < maxProjectThreadBindings; i++ {
		next, _ := identity.NewUUID()
		rememberThread(t, p, fmt.Sprint(i), next, 1, 1000, 0)
	}
	extra, _ := identity.NewUUID()
	data, _ := json.Marshal(map[string]any{"pending": true, "thread_id": extra, "version": 1, "wait_remaining_ms": 1000, "wait_protocol": 1})
	if code := p.rememberThreadWait(protocol.ProjectRuntimeRequest{ToolCallID: "extra"}, data, 0); code != "capacity_exceeded" {
		t.Fatalf("未限制绑定: %s", code)
	}
	if code := p.rememberThreadWait(protocol.ProjectRuntimeRequest{ToolCallID: "call-1"}, json.RawMessage(`{"kind":"tool_result"}`), 0); code != "" {
		t.Fatal(code)
	}
	if _, exists := p.threadWaits[id]; exists {
		t.Fatal("工具结束后未清理绑定")
	}
	rememberThread(t, p, "extra", extra, 1, 1000, 0)
}

func TestThreadWaitAllowsConcurrentCoordinatorTraffic(t *testing.T) {
	m, requests, _ := projectRuntimeFixture(t)
	command := projectCommand()
	sendProjectCommand(m, command)
	waitProjectRequest(t, requests, "started")
	m.mu.Lock()
	p := m.runs[command.RunID]
	m.mu.Unlock()
	id, _ := identity.NewUUID()
	started, err := m.clock.Mono()
	if err != nil {
		t.Fatal(err)
	}
	rememberThread(t, p, "call-1", id, 7, 30_000, started)
	result := make(chan protocol.ProjectRuntimeResult, 1)
	go func() { result <- pollThreadRequest(m, p, id, 7, 25000) }()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	preview, terminate := m.runtimeRequest(ctx, p, protocol.ProjectRuntimeRequest{Operation: "preview", Payload: json.RawMessage(`{"text":"waiting"}`)})
	if !preview.OK || terminate {
		t.Fatalf("本机等待阻塞了其他中心请求: %+v", preview)
	}
	waitProjectRequest(t, requests, "preview")
	threadNotification(m, p, id, 8)
	select {
	case got := <-result:
		assertThreadWake(t, got, "thread_changed", 8)
	case <-ctx.Done():
		t.Fatal("Thread 通知未结束本机等待")
	}
}

func TestThreadWaitBindsCoordinatorResponsesAndReleasesResult(t *testing.T) {
	for _, operation := range []string{"call_tool", "wait_tool"} {
		t.Run(operation, func(t *testing.T) {
			m := receiptManager(t, "")
			id, _ := identity.NewUUID()
			pending, _ := json.Marshal(map[string]any{"pending": true, "thread_id": id, "version": 7, "wait_remaining_ms": 30000, "wait_protocol": 1})
			final := json.RawMessage(`{"kind":"tool_result","seq":2,"payload":{"message":{"role":"toolResult","toolCallId":"exec-1"}}}`)
			receiptConnection(t, m, func(_ context.Context, req protocol.ProjectRuntimeRequest) (protocol.ProjectRuntimeResult, bool) {
				if req.LastSeq == 99 {
					return protocol.ProjectRuntimeResult{Code: "seq_conflict", Data: pending}, true
				}
				if string(req.Payload) == `{"finish_wait":true}` {
					return protocol.ProjectRuntimeResult{OK: true, Data: final}, true
				}
				return protocol.ProjectRuntimeResult{OK: true, Data: pending}, true
			})
			p := syntheticProjectProcess(m, projectCommand())
			req := protocol.ProjectRuntimeRequest{Operation: operation, ToolCallID: "exec-1", ToolName: "nodes.exec", LastSeq: 99}
			result, terminate := m.runtimeRequest(t.Context(), p, req)
			if result.OK || result.Code != "seq_conflict" || terminate {
				t.Fatalf("中心拒绝未返回给 Runtime: %+v", result)
			}
			threadNotification(m, p, id, 100)
			if got := pollThreadRequest(m, p, id, 0, 1); got.Code != "invalid_request" {
				t.Fatalf("失败响应或通知建立了等待绑定: %+v", got)
			}

			req.LastSeq = 1
			result, terminate = m.runtimeRequest(t.Context(), p, req)
			if !result.OK || terminate || string(result.Data) != string(pending) {
				t.Fatalf("pending 响应被修改: %+v", result)
			}
			assertThreadWake(t, pollThreadRequest(m, p, id, 7, 1), "timeout", 7)
			other := syntheticProjectProcess(m, projectCommand())
			if got := pollThreadRequest(m, other, id, 7, 1); got.Code != "invalid_request" {
				t.Fatalf("其他 run 使用了等待绑定: %+v", got)
			}
			threadNotification(m, p, id, 8)
			assertThreadWake(t, pollThreadRequest(m, p, id, 7, 25000), "thread_changed", 8)

			req.Operation = "wait_tool"
			req.Payload = json.RawMessage(`{"finish_wait":true}`)
			result, terminate = m.runtimeRequest(t.Context(), p, req)
			if !result.OK || terminate || string(result.Data) != string(final) {
				t.Fatalf("工具结果被修改: %+v", result)
			}
			threadNotification(m, p, id, 9)
			if got := pollThreadRequest(m, p, id, 7, 1); got.Code != "invalid_request" {
				t.Fatalf("工具结束后仍可等待 Thread: %+v", got)
			}
			p.threadMu.Lock()
			waits, calls := len(p.threadWaits), len(p.threadCalls)
			p.threadMu.Unlock()
			if waits != 0 || calls != 0 {
				t.Fatalf("工具结束后未释放记录: waits=%d calls=%d", waits, calls)
			}
		})
	}
}

func TestLocalWaitCapabilityPreservesBootstrapFields(t *testing.T) {
	result := localWaitCapability(protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, OK: true, Data: json.RawMessage(`{"future":42}`)})
	var data map[string]int
	if !result.OK || json.Unmarshal(result.Data, &data) != nil || data["future"] != 42 || data["local_wait_protocol"] != 1 {
		t.Fatalf("能力协商丢失响应字段: %+v %s", result, result.Data)
	}
}
