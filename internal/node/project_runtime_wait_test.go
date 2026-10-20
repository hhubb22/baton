package node

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/startpermit"
)

func taskWaitFixture(t *testing.T) (*projectRuntimeManager, *projectRuntimeProcess, *startpermit.Manual, string) {
	t.Helper()
	clock := startpermit.NewManual(time.Time{})
	p := &projectRuntimeProcess{command: projectCommand(), ctx: t.Context(), done: make(chan struct{}), wake: make(chan struct{}, 1), stop: func() {}, started: true}
	m := &projectRuntimeManager{ctx: t.Context(), clock: clock, leaseDeadline: time.Minute, runs: map[string]*projectRuntimeProcess{p.command.RunID: p}}
	id, _ := identity.NewUUID()
	rememberTask(t, p, "call-1", id, 7, 30_000, 0)
	return m, p, clock, id
}

func rememberTask(t *testing.T, p *projectRuntimeProcess, call, task string, version, remaining int64, started time.Duration) {
	t.Helper()
	data, err := json.Marshal(map[string]any{"pending": true, "task_id": task, "task_version": version, "wait_remaining_ms": remaining, "wait_protocol": 1})
	if err != nil {
		t.Fatal(err)
	}
	if code := p.rememberTaskWait(protocol.ProjectRuntimeRequest{ToolCallID: call}, data, started); code != "" {
		t.Fatal(code)
	}
}

func pollTaskRequest(m *projectRuntimeManager, p *projectRuntimeProcess, id string, version int64, waitMS int) protocol.ProjectRuntimeResult {
	payload, _ := json.Marshal(map[string]any{"task_id": id, "after_version": version, "wait_ms": waitMS})
	result, _ := m.runtimeRequest(p.ctx, p, protocol.ProjectRuntimeRequest{Operation: "poll_wake", Payload: payload})
	return result
}

func assertTaskWake(t *testing.T, result protocol.ProjectRuntimeResult, reason string, version int64) {
	t.Helper()
	var data struct {
		Reason  string `json:"reason"`
		Version int64  `json:"version"`
	}
	if !result.OK || json.Unmarshal(result.Data, &data) != nil || data.Reason != reason || data.Version != version {
		t.Fatalf("expected %s/%d, got %+v %s", reason, version, result, result.Data)
	}
}

func taskNotification(m *projectRuntimeManager, p *projectRuntimeProcess, id string, version int64) {
	command := p.command
	command.Type = protocol.BodyProjectRunWake
	command.TaskUpdates = []protocol.ProjectTaskUpdate{{TaskID: id, Version: version}}
	m.command(command)
}

func TestTaskWaitCachesNotificationBeforeSubscribe(t *testing.T) {
	m, p, _, id := taskWaitFixture(t)
	taskNotification(m, p, id, 8)
	assertTaskWake(t, pollTaskRequest(m, p, id, 7, 25000), "task_changed", 8)
}

func TestTaskWaitAcceptsOutOfOrderStateResponses(t *testing.T) {
	m, p, _, id := taskWaitFixture(t)
	rememberTask(t, p, "call-1", id, 8, 20_000, 0)
	rememberTask(t, p, "call-1", id, 7, 19_000, 0)
	assertTaskWake(t, pollTaskRequest(m, p, id, 8, 1), "timeout", 8)
	other, _ := identity.NewUUID()
	raw, _ := json.Marshal(map[string]any{"pending": true, "task_id": other, "task_version": 1, "wait_remaining_ms": 1000, "wait_protocol": 1})
	if code := p.rememberTaskWait(protocol.ProjectRuntimeRequest{ToolCallID: "call-1"}, raw, 0); code != "unavailable" {
		t.Fatalf("同一工具调用被重新绑定到其他任务: %s", code)
	}
}

func TestTaskWaitLatePendingCannotRestoreCompletedBinding(t *testing.T) {
	_, p, _, id := taskWaitFixture(t)
	req := protocol.ProjectRuntimeRequest{Operation: "wait_tool", ToolCallID: "call-1"}
	slow := p.beginTaskCall(req.ToolCallID)
	fast := p.beginTaskCall(req.ToolCallID)
	final := protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, OK: true, Data: json.RawMessage(`{"kind":"tool_result","seq":2}`)}
	if got := p.finishTaskCall(fast, req, final, 0); !got.OK {
		t.Fatal(got)
	}
	pending, _ := json.Marshal(map[string]any{"pending": true, "task_id": id, "task_version": 7, "wait_remaining_ms": 30000, "wait_protocol": 1})
	got := p.finishTaskCall(slow, req, protocol.ProjectRuntimeResult{OK: true, Data: pending}, 0)
	if !got.OK || string(got.Data) != string(final.Data) || len(p.taskWaits) != 0 || len(p.taskCalls) != 0 {
		t.Fatalf("迟到 pending 重建绑定或没有释放在途记录: %+v waits=%d calls=%d", got, len(p.taskWaits), len(p.taskCalls))
	}
	// 新的查询不复用已清理的响应缓存，失效来源仍然返回错误。
	late := p.beginTaskCall(req.ToolCallID)
	revoked := projectRuntimeFailure("lease_lost")
	if got := p.finishTaskCall(late, req, revoked, 0); got.Code != "lease_lost" || len(p.taskCalls) != 0 {
		t.Fatalf("完成缓存掩盖了来源失效: %+v", got)
	}
}

func TestTaskWaitBroadcastsToConcurrentSubscribers(t *testing.T) {
	m, p, _, id := taskWaitFixture(t)
	results := make(chan protocol.ProjectRuntimeResult, 2)
	for range 2 {
		go func() { results <- pollTaskRequest(m, p, id, 7, 25000) }()
	}
	taskNotification(m, p, id, 8)
	for range 2 {
		select {
		case result := <-results:
			assertTaskWake(t, result, "task_changed", 8)
		case <-time.After(time.Second):
			t.Fatal("任务更新未广播到全部等待者")
		}
	}
}

func TestTaskWaitFiltersGenericDuplicateAndStaleNotifications(t *testing.T) {
	m, p, _, id := taskWaitFixture(t)
	other, _ := identity.NewUUID()
	taskNotification(m, p, other, 100)
	taskNotification(m, p, id, 7)
	taskNotification(m, p, id, 6)
	command := p.command
	command.Type, command.LeaseEpoch = protocol.BodyProjectRunWake, command.LeaseEpoch-1
	command.TaskUpdates = []protocol.ProjectTaskUpdate{{TaskID: id, Version: 100}}
	m.command(command)
	assertTaskWake(t, pollTaskRequest(m, p, id, 7, 10), "timeout", 7)
	// 普通闲置通知仍可由原有协议消费。
	result, _ := m.runtimeRequest(t.Context(), p, protocol.ProjectRuntimeRequest{Operation: "poll_wake", Payload: json.RawMessage(`{"wait_ms":1}`)})
	if !result.OK || string(result.Data) != `{"wake":true}` {
		t.Fatalf("普通通知被任务等待消耗: %+v", result)
	}
}

func TestTaskWaitValidatesBoundTaskAndVersion(t *testing.T) {
	m, p, _, id := taskWaitFixture(t)
	unbound, _ := identity.NewUUID()
	for _, payload := range []string{
		fmt.Sprintf(`{"task_id":%q,"after_version":8,"wait_ms":1}`, id),
		fmt.Sprintf(`{"task_id":%q,"after_version":-1,"wait_ms":1}`, id),
		fmt.Sprintf(`{"task_id":%q,"wait_ms":1}`, id),
		fmt.Sprintf(`{"task_id":%q,"after_version":0,"wait_ms":1}`, unbound),
		`{"task_id":"invalid","after_version":0,"wait_ms":1}`,
		`{"after_version":0,"wait_ms":1}`,
		fmt.Sprintf(`{"task_id":%q,"after_version":7,"wait_ms":25001}`, id),
	} {
		result, _ := m.runtimeRequest(t.Context(), p, protocol.ProjectRuntimeRequest{Operation: "poll_wake", Payload: json.RawMessage(payload)})
		if result.OK || result.Code != "invalid_request" {
			t.Fatalf("接受无效等待 %s: %+v", payload, result)
		}
	}
}

func TestTaskWaitCountsRoundTripAndSuspendAgainstBudget(t *testing.T) {
	m, p, clock, id := taskWaitFixture(t)
	// 中心返回 5 秒剩余预算；请求始于 0，响应耗时 2 秒。
	clock.Advance(2 * time.Second)
	rememberTask(t, p, "call-1", id, 7, 5_000, 0)
	clock.Suspend(4 * time.Second)
	assertTaskWake(t, pollTaskRequest(m, p, id, 7, 25000), "timeout", 7)
}

func TestTaskWaitRechecksSuspendWhileWaiting(t *testing.T) {
	m, p, clock, id := taskWaitFixture(t)
	rememberTask(t, p, "call-1", id, 7, 5_000, 0)
	result := make(chan protocol.ProjectRuntimeResult, 1)
	go func() { result <- pollTaskRequest(m, p, id, 7, 25000) }()
	clock.Suspend(6 * time.Second)
	select {
	case got := <-result:
		assertTaskWake(t, got, "timeout", 7)
	case <-time.After(2 * time.Second):
		t.Fatal("休眠后没有按包含休眠的预算结束等待")
	}
}

func TestTaskWaitStopsOnLeaseLossAndClockFailure(t *testing.T) {
	for _, failure := range []string{"lease", "clock"} {
		t.Run(failure, func(t *testing.T) {
			m, p, clock, id := taskWaitFixture(t)
			if failure == "lease" {
				clock.Suspend(time.Minute)
			} else {
				bad := &failingProjectRuntimeClock{Manual: clock}
				bad.failed.Store(true)
				m.clock = bad
			}
			result := pollTaskRequest(m, p, id, 7, 25000)
			if result.OK || result.Code != "lease_lost" {
				t.Fatalf("失效后仍然等待: %+v", result)
			}
		})
	}
}

func TestTaskWaitCancellationReleasesSubscriber(t *testing.T) {
	m, p, _, id := taskWaitFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	result := m.pollTaskWake(ctx, p, id, 7, 25*time.Second)
	if result.OK || result.Code != "unavailable" {
		t.Fatalf("取消后未结束: %+v", result)
	}
	// 后续订阅仍可收到通知，没有遗留的消费者取走信号。
	taskNotification(m, p, id, 8)
	assertTaskWake(t, pollTaskRequest(m, p, id, 7, 25000), "task_changed", 8)
}

func TestTaskBindingsBoundedAndReleasedAfterToolResult(t *testing.T) {
	_, p, _, id := taskWaitFixture(t)
	for i := 1; i < maxProjectTaskBindings; i++ {
		next, _ := identity.NewUUID()
		rememberTask(t, p, fmt.Sprint(i), next, 1, 1000, 0)
	}
	extra, _ := identity.NewUUID()
	data, _ := json.Marshal(map[string]any{"pending": true, "task_id": extra, "task_version": 1, "wait_remaining_ms": 1000, "wait_protocol": 1})
	if code := p.rememberTaskWait(protocol.ProjectRuntimeRequest{ToolCallID: "extra"}, data, 0); code != "capacity_exceeded" {
		t.Fatalf("未限制绑定: %s", code)
	}
	if code := p.rememberTaskWait(protocol.ProjectRuntimeRequest{ToolCallID: "call-1"}, json.RawMessage(`{"kind":"tool_result"}`), 0); code != "" {
		t.Fatal(code)
	}
	if _, exists := p.taskWaits[id]; exists {
		t.Fatal("工具结束后未清理绑定")
	}
	rememberTask(t, p, "extra", extra, 1, 1000, 0)
}

func TestTaskWaitAllowsConcurrentCoordinatorTraffic(t *testing.T) {
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
	rememberTask(t, p, "call-1", id, 7, 30_000, started)
	result := make(chan protocol.ProjectRuntimeResult, 1)
	go func() { result <- pollTaskRequest(m, p, id, 7, 25000) }()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	preview, terminate := m.runtimeRequest(ctx, p, protocol.ProjectRuntimeRequest{Operation: "preview", Payload: json.RawMessage(`{"text":"waiting"}`)})
	if !preview.OK || terminate {
		t.Fatalf("本机等待阻塞了其他中心请求: %+v", preview)
	}
	waitProjectRequest(t, requests, "preview")
	taskNotification(m, p, id, 8)
	select {
	case got := <-result:
		assertTaskWake(t, got, "task_changed", 8)
	case <-ctx.Done():
		t.Fatal("任务通知未结束本机等待")
	}
}

func TestLocalWaitCapabilityPreservesBootstrapFields(t *testing.T) {
	result := localWaitCapability(protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, OK: true, Data: json.RawMessage(`{"future":42}`)})
	var data map[string]int
	if !result.OK || json.Unmarshal(result.Data, &data) != nil || data["future"] != 42 || data["local_wait_protocol"] != 1 {
		t.Fatalf("能力协商丢失响应字段: %+v %s", result, result.Data)
	}
}
