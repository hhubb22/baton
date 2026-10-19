package node

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"baton/internal/identity"
	"baton/internal/privatefile"
	"baton/internal/protocol"
	"baton/internal/session"
	"baton/internal/sidecar"
	"baton/internal/startpermit"
)

const projectRuntimeMaxBytes = 192 << 10
const projectRuntimeRenewInterval = 20 * time.Second
const projectRuntimeLeaseDeadline = 58 * time.Second

type projectRuntimeManager struct {
	ctx           context.Context
	cancel        context.CancelFunc
	ledger        *Ledger
	reports       *runtimeReports
	mu            sync.Mutex
	closed        bool
	loop          *startLoop
	runs          map[string]*projectRuntimeProcess
	wg            sync.WaitGroup
	renewInterval time.Duration
	leaseDeadline time.Duration
	clock         startpermit.Timer
}

type projectRuntimeProcess struct {
	command   protocol.ProjectRunCommand
	token     string
	wake      chan struct{}
	done      chan struct{}
	finished  chan struct{}
	stop      func()
	lastRenew atomic.Int64
	ctx       context.Context
	cancel    context.CancelFunc
	stopped   bool
	started   bool
}

func newProjectRuntimeManager(ctx context.Context, ledger *Ledger) (*projectRuntimeManager, error) {
	if _, err := ledger.db.Exec(`CREATE TABLE IF NOT EXISTS project_runtime_runs (run_id TEXT PRIMARY KEY, lease_epoch INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '')`); err != nil {
		return nil, err
	}
	// 启动意图在创建进程前提交；崩溃后不重复启动同一 run。进程守护随 batond 管道关闭终止遗留进程。
	if _, err := ledger.db.Exec(`UPDATE project_runtime_runs SET state='exited', reason='batond_restarted' WHERE state IN ('starting','running')`); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	return &projectRuntimeManager{ctx: ctx, cancel: cancel, ledger: ledger, runs: map[string]*projectRuntimeProcess{}, renewInterval: projectRuntimeRenewInterval, leaseDeadline: projectRuntimeLeaseDeadline, clock: startpermit.NewClock()}, nil
}

func (m *projectRuntimeManager) setLoop(loop *startLoop) {
	m.mu.Lock()
	m.loop = loop
	m.mu.Unlock()
}

func (m *projectRuntimeManager) close() {
	m.mu.Lock()
	m.closed = true
	m.cancel()
	for _, p := range m.runs {
		p.stop()
	}
	m.mu.Unlock()
	m.wg.Wait()
}

func projectRuntimeFailure(code string) protocol.ProjectRuntimeResult {
	return protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, Code: code}
}

func (m *projectRuntimeManager) call(ctx context.Context, req protocol.ProjectRuntimeRequest) protocol.ProjectRuntimeResult {
	m.mu.Lock()
	loop := m.loop
	m.mu.Unlock()
	if loop == nil {
		return projectRuntimeFailure("unavailable")
	}
	req.Type = protocol.BodyProjectRuntimeRequest
	raw, err := protocol.MarshalJSON(req)
	if err != nil || len(raw) > projectRuntimeMaxBytes {
		return projectRuntimeFailure("invalid_request")
	}
	raw, err = loop.roundTrip(ctx, raw)
	if err != nil || len(raw) > projectRuntimeMaxBytes {
		return projectRuntimeFailure("unavailable")
	}
	var result protocol.ProjectRuntimeResult
	if json.Unmarshal(raw, &result) != nil || result.Type != protocol.BodyProjectRuntimeResult {
		return projectRuntimeFailure("unavailable")
	}
	return result
}

func (m *projectRuntimeManager) report(command protocol.ProjectRunCommand, operation, reason string) protocol.ProjectRuntimeResult {
	ctx, cancel := context.WithTimeout(m.ctx, 5*time.Second)
	defer cancel()
	return m.call(ctx, protocol.ProjectRuntimeRequest{RunID: command.RunID, LeaseEpoch: command.LeaseEpoch, Operation: operation, Reason: reason})
}

func (m *projectRuntimeManager) handle(env protocol.Envelope) bool {
	var command protocol.ProjectRunCommand
	if json.Unmarshal(env.Body, &command) != nil {
		return false
	}
	switch command.Type {
	case "project_run_start", "project_run_stop", "project_run_wake":
	default:
		return false
	}
	if _, err := identity.ParseUUID(command.RunID); err != nil || command.LeaseEpoch <= 0 {
		return true
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return true
	}
	m.wg.Add(1)
	m.mu.Unlock()
	go func() { defer m.wg.Done(); m.command(command) }()
	return true
}

func (m *projectRuntimeManager) command(command protocol.ProjectRunCommand) {
	m.mu.Lock()
	if p := m.runs[command.RunID]; p != nil {
		if p.command.LeaseEpoch != command.LeaseEpoch {
			m.mu.Unlock()
			return
		}
		if p.started && command.Type != "project_run_stop" {
			if _, err := m.leaseTime(p); err != nil {
				p.stop()
				m.mu.Unlock()
				return
			}
		}
		switch command.Type {
		case "project_run_stop":
			p.stopped = true
			p.stop()
		case "project_run_wake":
			select {
			case p.wake <- struct{}{}:
			default:
			}
		}
		started := p.started
		finished := p.finished
		m.mu.Unlock()
		if command.Type == "project_run_stop" {
			<-finished
			m.report(command, "stopped", "")
		}
		if command.Type == "project_run_start" && started {
			m.report(command, "started", "")
		}
		return
	}
	if command.Type != "project_run_start" {
		m.mu.Unlock()
		if command.Type == "project_run_stop" {
			m.report(command, "stopped", "")
		}
		return
	}
	var epoch int64
	var state, reason string
	err := m.ledger.db.QueryRow(`SELECT lease_epoch,state,reason FROM project_runtime_runs WHERE run_id=?`, command.RunID).Scan(&epoch, &state, &reason)
	if err == nil {
		m.mu.Unlock()
		if epoch == command.LeaseEpoch {
			if state == "failed" {
				m.report(command, "start_failed", reason)
			} else {
				m.report(command, "exited", reason)
			}
		}
		return
	}
	if len(m.runs) >= 4 {
		m.mu.Unlock()
		m.report(command, "start_failed", "capacity_exceeded")
		return
	}
	if _, err = m.ledger.db.Exec(`INSERT INTO project_runtime_runs(run_id,lease_epoch,state) VALUES(?,?,'starting')`, command.RunID, command.LeaseEpoch); err != nil {
		m.mu.Unlock()
		return
	}
	token := make([]byte, 32)
	if _, err = rand.Read(token); err != nil {
		m.mu.Unlock()
		m.failed(command, "unavailable")
		return
	}
	p := &projectRuntimeProcess{command: command, token: hex.EncodeToString(token), wake: make(chan struct{}, 1), done: make(chan struct{}), finished: make(chan struct{}), stop: func() {}}
	p.ctx, p.cancel = context.WithCancel(m.ctx)
	m.runs[command.RunID] = p
	m.mu.Unlock()
	defer p.cancel()
	defer close(p.finished)
	defer func() { m.mu.Lock(); delete(m.runs, command.RunID); m.mu.Unlock() }()
	probe := probeProjectRuntime(m.ctx)
	available := false
	if probe != nil {
		for _, provider := range probe.Providers {
			if provider.Provider == command.Provider && provider.Status == "available" {
				available = true
			}
		}
	}
	if !available {
		if m.reports != nil {
			select {
			case m.reports.refresh <- struct{}{}:
			default:
			}
		}
		m.failed(command, "login_required")
		return
	}
	if m.ctx.Err() != nil {
		m.failed(command, "unavailable")
		return
	}
	started, err := m.clock.Mono()
	if err != nil {
		m.failed(command, "unavailable")
		return
	}
	p.lastRenew.Store(int64(started))
	initial := m.report(command, "renew", "")
	if !initial.OK {
		m.failed(command, initial.Code)
		return
	}
	if err := m.run(p); err != nil {
		m.failed(command, "unavailable")
	}
}

func (m *projectRuntimeManager) failed(command protocol.ProjectRunCommand, reason string) {
	_, _ = m.ledger.db.Exec(`UPDATE project_runtime_runs SET state='failed',reason=? WHERE run_id=?`, reason, command.RunID)
	m.report(command, "start_failed", reason)
}

// leaseTime 使用包含系统休眠的单调时钟；请求开始时刻作为最近续租起点。
func (m *projectRuntimeManager) leaseTime(p *projectRuntimeProcess) (time.Duration, error) {
	now, err := m.clock.Mono()
	if err != nil {
		return 0, err
	}
	last := time.Duration(p.lastRenew.Load())
	if now < last || now-last >= m.leaseDeadline {
		return now, context.DeadlineExceeded
	}
	return now, nil
}

func (m *projectRuntimeManager) run(p *projectRuntimeProcess) error {
	root := filepath.Join(m.ledger.dir, "project-runtimes")
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	if err := privatefile.ProtectDir(root); err != nil {
		return err
	}
	if err := privatefile.CheckDir(root); err != nil {
		return err
	}
	control, err := os.MkdirTemp(root, "control-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(control)
	if err := privatefile.ProtectDir(control); err != nil {
		return err
	}
	if err := privatefile.CheckDir(control); err != nil {
		return err
	}
	endpoint, err := session.Endpoint(m.ledger.dir, p.command.RunID)
	if err != nil {
		return err
	}
	ln, err := session.ListenLocal(endpoint)
	if err != nil {
		return err
	}
	defer ln.Close()
	defer os.Remove(endpoint)
	cmd, err := sidecar.Command(p.ctx, "project-agent", projectRuntimeVersion, "baton-project-runtime", "run")
	if err != nil {
		return err
	}
	cmd.Dir = control
	host, err := os.Executable()
	if err != nil {
		return err
	}
	cmd.Env = append(os.Environ(), "BATON_SIDECAR_HOST="+host, "BATON_SIDECAR_TRANSPORT=stdio", "BATON_PROJECT_RUNTIME_ENDPOINT="+endpoint, "BATON_PROJECT_RUNTIME_TOKEN="+p.token, "BATON_PROJECT_RUN_ID="+p.command.RunID, "BATON_PROJECT_LEASE_EPOCH="+strconv.FormatInt(p.command.LeaseEpoch, 10))

	input, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	defer output.Close()

	m.mu.Lock()
	if _, err := m.leaseTime(p); err != nil {
		m.mu.Unlock()
		return err
	}
	if p.stopped || m.ctx.Err() != nil {
		m.mu.Unlock()
		return context.Canceled
	}
	process, err := sidecar.Start(cmd)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	stop := process.Stop
	p.stop = stop
	p.started = true
	m.mu.Unlock()
	defer stop()
	_, _ = m.ledger.db.Exec(`UPDATE project_runtime_runs SET state='running' WHERE run_id=?`, p.command.RunID)
	stdioDone := make(chan struct{})
	go func() {
		defer close(stdioDone)
		err := sidecar.Serve(p.ctx, output, input, func(ctx context.Context, raw json.RawMessage) any {
			var req protocol.ProjectRuntimeRequest
			dec := json.NewDecoder(bytes.NewReader(raw))
			if dec.Decode(&req) != nil || dec.Decode(new(any)) != io.EOF {
				return projectRuntimeFailure("invalid_request")
			}
			result, terminate := m.runtimeRequest(ctx, p, req)
			if terminate {
				time.AfterFunc(100*time.Millisecond, p.stop)
			}
			return result
		})
		if err != nil {
			p.stop()
		}
	}()
	go func() { _ = process.Wait(); p.cancel(); close(p.done); _ = ln.Close() }()
	defer func() { stop(); _ = output.Close(); _ = input.Close(); <-stdioDone }()
	ipcDone := make(chan struct{})
	go func() { defer close(ipcDone); m.serve(ln, p) }()
	defer func() { _ = ln.Close(); <-ipcDone }()
	startedResult := make(chan protocol.ProjectRuntimeResult, 1)
	go func(result chan<- protocol.ProjectRuntimeResult) {
		if _, err := m.leaseTime(p); err != nil {
			result <- projectRuntimeFailure("lease_lost")
			return
		}
		result <- m.report(p.command, "started", "")
	}(startedResult)
	renew := time.NewTicker(m.renewInterval)
	defer renew.Stop()
	// Go 计时器只唤醒检查，租约判断始终读取包含休眠的 Mono。
	checkTicker := time.NewTicker(min(time.Second, m.leaseDeadline))
	defer checkTicker.Stop()
	deadline := time.NewTimer(m.leaseDeadline)
	defer deadline.Stop()
	leaseLost := false
	checkLease := func() bool {
		if leaseLost {
			return false
		}
		if _, err := m.leaseTime(p); err != nil {
			leaseLost = true
			stop()
			return false
		}
		return true
	}
	resetDeadline := func() {
		now, err := m.leaseTime(p)
		if err != nil {
			leaseLost = true
			stop()
			return
		}
		if !deadline.Stop() {
			select {
			case <-deadline.C:
			default:
			}
		}
		deadline.Reset(m.leaseDeadline - (now - time.Duration(p.lastRenew.Load())))
	}
	resetDeadline()
	type renewal struct {
		result   protocol.ProjectRuntimeResult
		started  time.Duration
		clockErr error
	}
	renewResult := make(chan renewal, 1)
	renewBusy := false
	for {
		checkLease()
		select {
		case <-m.ctx.Done():
			stop()
			<-p.done
			return nil
		case <-p.done:
			_, _ = m.ledger.db.Exec(`UPDATE project_runtime_runs SET state='exited',reason='runtime_exited' WHERE run_id=?`, p.command.RunID)
			m.report(p.command, "exited", "runtime_exited")
			return nil
		case initial := <-startedResult:
			startedResult = nil
			if !initial.OK && initial.Code != "unavailable" {
				leaseLost = true
				stop()
			}
		case <-checkTicker.C:
		case <-deadline.C:
			if checkLease() {
				resetDeadline()
			}
		case <-renew.C:
			if !checkLease() {
				continue
			}
			if !renewBusy {
				renewBusy = true
				go func() {
					// 协程恢复执行时也须先核对期限，不能在休眠后先发送续租。
					started, err := m.leaseTime(p)
					if err != nil {
						renewResult <- renewal{clockErr: err}
						return
					}
					renewResult <- renewal{result: m.report(p.command, "renew", ""), started: started}
				}()
			}
		case renewed := <-renewResult:
			renewBusy = false
			if !checkLease() {
				continue
			}
			if renewed.clockErr != nil {
				leaseLost = true
				stop()
				continue
			}
			if renewed.result.OK {
				p.lastRenew.Store(int64(renewed.started))
				resetDeadline()
			} else if renewed.result.Code == "lease_lost" {
				leaseLost = true
				stop()
			}
		}
	}
}

func (m *projectRuntimeManager) serve(ln net.Listener, p *projectRuntimeProcess) {
	var wg sync.WaitGroup
	defer wg.Wait()
	limit := make(chan struct{}, 8)
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		select {
		case limit <- struct{}{}:
			wg.Add(1)
			go func() { defer wg.Done(); defer func() { <-limit }(); m.serveConn(conn, p) }()
		default:
			conn.Close()
		}
	}
}

func (m *projectRuntimeManager) serveConn(conn net.Conn, p *projectRuntimeProcess) {
	defer conn.Close()
	stop := context.AfterFunc(p.ctx, func() { _ = conn.Close() })
	defer stop()
	_ = conn.SetDeadline(time.Now().Add(32 * time.Second))
	var local struct {
		Token   string                         `json:"token"`
		Request protocol.ProjectRuntimeRequest `json:"request"`
	}
	dec := json.NewDecoder(io.LimitReader(conn, projectRuntimeMaxBytes+1))
	result := projectRuntimeFailure("invalid_request")
	terminate := false
	if dec.Decode(&local) == nil && dec.InputOffset() <= projectRuntimeMaxBytes {
		if subtle.ConstantTimeCompare([]byte(local.Token), []byte(p.token)) != 1 {
			result = projectRuntimeFailure("forbidden")
		} else {
			select {
			case <-p.done:
				result = projectRuntimeFailure("lease_lost")
			default:
				if _, err := m.leaseTime(p); err != nil {
					p.stop()
					_ = json.NewEncoder(conn).Encode(projectRuntimeFailure("lease_lost"))
					return
				}
				result, terminate = m.runtimeRequest(p.ctx, p, local.Request)
			}
		}
	}
	encoder := json.NewEncoder(conn)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(result)
	if terminate {
		time.AfterFunc(100*time.Millisecond, p.stop)
	}
}

func (m *projectRuntimeManager) runtimeRequest(ctx context.Context, p *projectRuntimeProcess, req protocol.ProjectRuntimeRequest) (protocol.ProjectRuntimeResult, bool) {
	if _, err := m.leaseTime(p); err != nil {
		p.stop()
		return projectRuntimeFailure("lease_lost"), true
	}
	req.Type = protocol.BodyProjectRuntimeRequest
	req.RunID = p.command.RunID
	req.LeaseEpoch = p.command.LeaseEpoch
	result := projectRuntimeFailure("invalid_request")
	switch req.Operation {
	case "poll_wake":
		wait := 25 * time.Second
		var options struct {
			WaitMS int `json:"wait_ms"`
		}
		if len(req.Payload) > 0 {
			if json.Unmarshal(req.Payload, &options) != nil || options.WaitMS < 1 || options.WaitMS > 25000 {
				return result, false
			}
			wait = time.Duration(options.WaitMS) * time.Millisecond
		}
		timer := time.NewTimer(wait)
		defer timer.Stop()
		wake := false
		select {
		case <-p.wake:
			wake = true
		case <-timer.C:
		case <-p.done:
		case <-ctx.Done():
		}
		data, _ := protocol.MarshalJSON(struct {
			Wake bool `json:"wake"`
		}{wake})
		result = protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, OK: true, Data: data}
	case "bootstrap", "read_events", "claim_inputs", "append_event", "preview", "call_tool", "wait_tool", "report_failure", "finish":
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		result = m.call(ctx, req)
		cancel()
	}
	if _, err := m.leaseTime(p); err != nil {
		result = projectRuntimeFailure("lease_lost")
		p.stop()
	}
	return result, result.Code == "lease_lost" || result.OK && (req.Operation == "finish" || req.Operation == "report_failure")
}
