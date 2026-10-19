package node

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/startpermit"

	"github.com/coder/websocket"
)

func projectRuntimeFixture(t *testing.T, beforeReply ...func(protocol.ProjectRuntimeRequest)) (*projectRuntimeManager, chan protocol.ProjectRuntimeRequest, string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	dir := t.TempDir()
	binary := filepath.Join(dir, "baton-project-runtime")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", binary, "./testdata/project_runtime_stub.go")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	log := filepath.Join(t.TempDir(), "runtime.jsonl")
	t.Setenv("BATON_TEST_PROJECT_RUNTIME_LOG", log)
	ledger, err := OpenLedger(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ledger.Close() })
	m, err := newProjectRuntimeManager(ctx, ledger)
	if err != nil {
		t.Fatal(err)
	}
	requests := make(chan protocol.ProjectRuntimeRequest, 128)
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
			if json.Unmarshal(raw, &frame) != nil {
				return
			}
			var request protocol.ProjectRuntimeRequest
			if json.Unmarshal(frame.Envelope.Body, &request) != nil {
				return
			}
			select {
			case requests <- request:
			case <-ctx.Done():
				return
			}
			for _, hook := range beforeReply {
				hook(request)
			}
			body, _ := json.Marshal(protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, OK: true, Data: json.RawMessage(`{"lease_seconds":60}`)})
			reply, _ := json.Marshal(protocol.Envelope{CorrelationID: frame.Envelope.MessageID, Body: body})
			if ws.Write(ctx, websocket.MessageText, reply) != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	loop := newStartLoop(ctx, Identity{}, ledger, nil, newWSWriter(ws), nil)
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
	t.Cleanup(func() { m.close(); ws.CloseNow(); <-done })
	return m, requests, log
}

func projectCommand() protocol.ProjectRunCommand {
	run, _ := identity.NewUUID()
	return protocol.ProjectRunCommand{Type: protocol.BodyProjectRunStart, RunID: run, LeaseEpoch: 7, Provider: "test", Model: "test"}
}

func waitProjectRequest(t *testing.T, requests <-chan protocol.ProjectRuntimeRequest, operation string) protocol.ProjectRuntimeRequest {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case request := <-requests:
			if request.Operation == operation {
				return request
			}
		case <-timer.C:
			t.Fatalf("未收到 %s", operation)
		}
	}
}

func sendProjectCommand(m *projectRuntimeManager, command protocol.ProjectRunCommand) {
	body, _ := json.Marshal(command)
	m.handle(protocol.Envelope{Body: body})
}

func localProjectRequest(t *testing.T, m *projectRuntimeManager, p *projectRuntimeProcess, token, operation string) protocol.ProjectRuntimeResult {
	t.Helper()
	client, server := net.Pipe()
	defer client.Close()
	go m.serveConn(server, p)
	err := json.NewEncoder(client).Encode(map[string]any{"token": token, "request": protocol.ProjectRuntimeRequest{Operation: operation, RunID: "forged", LeaseEpoch: 999}})
	if err != nil {
		t.Fatal(err)
	}
	var result protocol.ProjectRuntimeResult
	if err := json.NewDecoder(client).Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestProjectRuntimeBindingWakeAndPersistentDedup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("进程IPC端到端由Windows进程测试覆盖")
	}
	m, requests, log := projectRuntimeFixture(t)
	command := projectCommand()
	sendProjectCommand(m, command)
	request := waitProjectRequest(t, requests, "bootstrap")
	if request.RunID != command.RunID || request.LeaseEpoch != 7 {
		t.Fatalf("Runtime伪造身份被信任: %+v", request)
	}
	m.mu.Lock()
	p := m.runs[command.RunID]
	m.mu.Unlock()
	if result := localProjectRequest(t, m, p, "bad-token", "bootstrap"); result.Code != "forbidden" {
		t.Fatalf("bad token: %+v", result)
	}
	if result := localProjectRequest(t, m, p, p.token, "renew"); result.Code != "invalid_request" {
		t.Fatalf("Runtime获得续租权限: %+v", result)
	}
	command.Type = protocol.BodyProjectRunWake
	sendProjectCommand(m, command)
	result := localProjectRequest(t, m, p, p.token, "poll_wake")
	if !result.OK || string(result.Data) != `{"wake":true}` {
		t.Fatalf("wake: %+v", result)
	}
	command.Type = protocol.BodyProjectRunStart
	sendProjectCommand(m, command)
	waitProjectRequest(t, requests, "started")
	command.Type = protocol.BodyProjectRunStop
	sendProjectCommand(m, command)
	waitProjectRequest(t, requests, "exited")
	deadline := time.Now().Add(time.Second)
	for {
		m.mu.Lock()
		n := len(m.runs)
		m.mu.Unlock()
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("未清理退出进程")
		}
		time.Sleep(time.Millisecond)
	}
	command.Type = protocol.BodyProjectRunStart
	sendProjectCommand(m, command)
	waitProjectRequest(t, requests, "exited")
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(raw), "\n") != 1 || !strings.Contains(string(raw), `"files":0`) {
		t.Fatalf("重复启动或cwd非空: %s", raw)
	}
	// 重开管理器仍沿用 SQLite 启动意图。
	second, err := newProjectRuntimeManager(m.ctx, m.ledger)
	if err != nil {
		t.Fatal(err)
	}
	second.setLoop(m.loop)
	second.command(command)
	waitProjectRequest(t, requests, "exited")
	raw, _ = os.ReadFile(log)
	if strings.Count(string(raw), "\n") != 1 {
		t.Fatalf("重启后重复启动: %s", raw)
	}
}

func TestProjectRuntimeLeaseDeadlineAcrossDisconnect(t *testing.T) {
	m, requests, _ := projectRuntimeFixture(t)
	m.renewInterval = 50 * time.Millisecond
	m.leaseDeadline = 300 * time.Millisecond
	command := projectCommand()
	sendProjectCommand(m, command)
	waitProjectRequest(t, requests, "started")
	m.mu.Lock()
	p := m.runs[command.RunID]
	m.mu.Unlock()
	m.setLoop(nil)
	select {
	case <-p.done:
	case <-time.After(2 * time.Second):
		t.Fatal("断开中心后未按本地租期停止Runtime")
	}
}

func TestProjectRuntimeProbeRejectsLoginRequired(t *testing.T) {
	m, requests, log := projectRuntimeFixture(t)
	t.Setenv("BATON_TEST_PROJECT_LOGIN_REQUIRED", "1")
	sendProjectCommand(m, projectCommand())
	request := waitProjectRequest(t, requests, "start_failed")
	if request.Reason != "login_required" {
		t.Fatalf("拒绝原因: %+v", request)
	}
	if _, err := os.Stat(log); !os.IsNotExist(err) {
		t.Fatal("未登录仍启动了Runtime")
	}
}

func TestProjectRuntimeCapacityAndStopAck(t *testing.T) {
	m, requests, _ := projectRuntimeFixture(t)
	var commands []protocol.ProjectRunCommand
	for range 4 {
		command := projectCommand()
		commands = append(commands, command)
		sendProjectCommand(m, command)
		waitProjectRequest(t, requests, "started")
	}
	fifth := projectCommand()
	sendProjectCommand(m, fifth)
	if request := waitProjectRequest(t, requests, "start_failed"); request.RunID != fifth.RunID || request.Reason != "capacity_exceeded" {
		t.Fatalf("未执行4进程限制: %+v", request)
	}
	commands[0].Type = protocol.BodyProjectRunStop
	sendProjectCommand(m, commands[0])
	if request := waitProjectRequest(t, requests, "stopped"); request.RunID != commands[0].RunID {
		t.Fatalf("stop ack: %+v", request)
	}
	m.mu.Lock()
	_, exists := m.runs[commands[0].RunID]
	m.mu.Unlock()
	if exists {
		t.Fatal("进程退出清理前确认了stop")
	}
}

func TestProjectRuntimeStopsAfterSystemSuspend(t *testing.T) {
	m, requests, _ := projectRuntimeFixture(t)
	clock := startpermit.NewManual(time.Time{})
	m.clock = clock
	m.renewInterval = 50 * time.Millisecond
	command := projectCommand()
	sendProjectCommand(m, command)
	waitProjectRequest(t, requests, "started")
	m.mu.Lock()
	p := m.runs[command.RunID]
	m.mu.Unlock()
	resumed := time.Now()
	clock.Suspend(59 * time.Second)
	select {
	case <-p.done:
	case <-time.After(2 * time.Second):
		t.Fatal("休眠耗尽租约后未在周期检查中停止Runtime")
	}
	if time.Since(resumed) >= projectRuntimeLeaseDeadline {
		t.Fatal("测试没有隔离Go计时器与包含休眠的单调时钟")
	}
	// 启动已完成的续租已经由waitProjectRequest读走，恢复后不得再发送续租。
	for {
		select {
		case request := <-requests:
			if request.Operation == "renew" {
				t.Fatal("本地租约过期后仍向中心发送续租")
			}
		default:
			return
		}
	}
}

func TestProjectRuntimeCountsRenewalRoundTripFromRequestStart(t *testing.T) {
	clock := startpermit.NewManual(time.Time{})
	var renewals atomic.Int32
	m, requests, _ := projectRuntimeFixture(t, func(request protocol.ProjectRuntimeRequest) {
		if request.Operation == "renew" && renewals.Add(1) == 1 {
			clock.Advance(15 * time.Second)
		}
	})
	m.clock = clock
	command := projectCommand()
	sendProjectCommand(m, command)
	waitProjectRequest(t, requests, "started")
	m.mu.Lock()
	p := m.runs[command.RunID]
	m.mu.Unlock()
	clock.Suspend(44 * time.Second)
	select {
	case <-p.done:
	case <-time.After(2 * time.Second):
		t.Fatal("续租往返耗时未计入58秒本地期限")
	}
}

type failingProjectRuntimeClock struct {
	*startpermit.Manual
	failed atomic.Bool
}

func (c *failingProjectRuntimeClock) Mono() (time.Duration, error) {
	if c.failed.Load() {
		return 0, errors.New("单调时钟读取失败")
	}
	return c.Manual.Mono()
}

func TestProjectRuntimeStopsWhenMonotonicClockFails(t *testing.T) {
	m, requests, _ := projectRuntimeFixture(t)
	clock := &failingProjectRuntimeClock{Manual: startpermit.NewManual(time.Time{})}
	m.clock = clock
	command := projectCommand()
	sendProjectCommand(m, command)
	waitProjectRequest(t, requests, "started")
	m.mu.Lock()
	p := m.runs[command.RunID]
	m.mu.Unlock()
	clock.failed.Store(true)
	select {
	case <-p.done:
	case <-time.After(2 * time.Second):
		t.Fatal("单调时钟失效后仍保持Runtime")
	}
}

func TestProjectRuntimeRejectsLateRenewalAfterSuspend(t *testing.T) {
	clock := startpermit.NewManual(time.Time{})
	var renewals atomic.Int32
	pending := make(chan struct{})
	release := make(chan struct{})
	m, requests, _ := projectRuntimeFixture(t, func(request protocol.ProjectRuntimeRequest) {
		if request.Operation == "renew" && renewals.Add(1) == 2 {
			close(pending)
			<-release
		}
	})
	m.clock = clock
	m.renewInterval = 50 * time.Millisecond
	command := projectCommand()
	sendProjectCommand(m, command)
	waitProjectRequest(t, requests, "started")
	m.mu.Lock()
	p := m.runs[command.RunID]
	m.mu.Unlock()
	select {
	case <-pending:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("未收到第二次续租")
	}
	clock.Suspend(59 * time.Second)
	// 回复在恢复之后到达，不能据此延长已耗尽的本地租期。
	close(release)
	select {
	case <-p.done:
	case <-time.After(2 * time.Second):
		t.Fatal("休眠后迟到的成功续租恢复了旧Runtime")
	}
	if got := time.Duration(p.lastRenew.Load()); got != 0 {
		t.Fatalf("迟到续租修改了起点: %s", got)
	}
}
