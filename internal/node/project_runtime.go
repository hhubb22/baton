package node

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
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
	ctx             context.Context
	cancel          context.CancelFunc
	ledger          *Ledger
	reports         *runtimeReports
	mu              sync.Mutex
	closed          bool
	loop            *startLoop
	runs            map[string]*projectRuntimeProcess
	wg              sync.WaitGroup
	renewInterval   time.Duration
	leaseDeadline   time.Duration
	clock           startpermit.Timer
	controlReceipts bool
	wakeReceipts    chan projectWakeReceipt
	cleanupReady    chan struct{}
}

type projectRuntimeProcess struct {
	command        protocol.ProjectRunCommand
	token          string
	wake           chan struct{}
	done           chan struct{}
	finished       chan struct{}
	stop           func()
	lastRenew      atomic.Int64
	ctx            context.Context
	cancel         context.CancelFunc
	stopped        bool
	started        bool
	cleanupFailed  bool
	cleanupPending bool
	threadMu       sync.Mutex
	threadWaits    map[string]*projectThreadWait
	threadCalls    map[string]*projectThreadCall
}

func newProjectRuntimeManager(ctx context.Context, ledger *Ledger) (*projectRuntimeManager, error) {
	if _, err := execProjectRuntime(ctx, ledger.db, `CREATE TABLE IF NOT EXISTS project_runtime_runs (run_id TEXT PRIMARY KEY, lease_epoch INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '')`); err != nil {
		return nil, err
	}
	if err := ensureProjectRuntimeCleanup(ledger.db); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	m := &projectRuntimeManager{ctx: ctx, cancel: cancel, ledger: ledger, runs: map[string]*projectRuntimeProcess{}, renewInterval: projectRuntimeRenewInterval, leaseDeadline: projectRuntimeLeaseDeadline, clock: startpermit.NewClock(), wakeReceipts: make(chan projectWakeReceipt, 64), cleanupReady: make(chan struct{}, 1)}
	m.wg.Add(2)
	go func() { defer m.wg.Done(); m.wakeReceiptLoop() }()
	go func() { defer m.wg.Done(); m.cleanupReceiptLoop() }()
	return m, nil
}

func (m *projectRuntimeManager) setLoop(loop *startLoop) {
	m.mu.Lock()
	if m.loop != loop {
		m.controlReceipts = false
	}
	m.loop = loop
	m.mu.Unlock()
	m.signalCleanup()
}

func (m *projectRuntimeManager) close() {
	m.mu.Lock()
	m.closed = true
	m.cancel()
	var stops []func()
	for _, p := range m.runs {
		p.stopped = true
		stops = append(stops, p.stop)
	}
	m.mu.Unlock()
	for _, stop := range stops {
		stop()
	}
	m.wg.Wait()
}

func projectRuntimeFailure(code string) protocol.ProjectRuntimeResult {
	return protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, Code: code}
}

func (m *projectRuntimeManager) call(ctx context.Context, req protocol.ProjectRuntimeRequest) protocol.ProjectRuntimeResult {
	m.mu.Lock()
	loop := m.loop
	m.mu.Unlock()
	return m.callOnLoop(ctx, req, loop)
}

func (m *projectRuntimeManager) callOnLoop(ctx context.Context, req protocol.ProjectRuntimeRequest, loop *startLoop) protocol.ProjectRuntimeResult {
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
	if result.OK && (req.Operation == "started" || req.Operation == "renew") {
		var data struct {
			ControlReceipts int `json:"control_receipts"`
		}
		_ = json.Unmarshal(result.Data, &data)
		m.mu.Lock()
		if m.loop == loop {
			m.controlReceipts = data.ControlReceipts == 1
		}
		m.mu.Unlock()
	}
	return result
}

func (m *projectRuntimeManager) report(command protocol.ProjectRunCommand, operation, reason string) protocol.ProjectRuntimeResult {
	return m.reportContext(m.ctx, command, operation, reason)
}

func (m *projectRuntimeManager) reportContext(parent context.Context, command protocol.ProjectRunCommand, operation, reason string) protocol.ProjectRuntimeResult {
	ctx, cancel := context.WithTimeout(parent, projectReceiptTimeout)
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
	if command.Type == protocol.BodyProjectRunWake {
		m.receiveWake(command)
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
	if command.Type == protocol.BodyProjectRunWake {
		m.receiveWake(command)
		return
	}
	m.mu.Lock()
	if p := m.runs[command.RunID]; p != nil {
		if p.command.LeaseEpoch != command.LeaseEpoch || p.stopped && command.Type != protocol.BodyProjectRunStop {
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
		}
		started := p.started
		finished := p.finished
		m.mu.Unlock()
		if command.Type == "project_run_stop" {
			<-finished
			m.signalCleanup()
		}
		if command.Type == "project_run_start" && started {
			m.report(command, "started", "")
		}
		return
	}
	if command.Type != "project_run_start" {
		if command.Type == "project_run_stop" {
			// 只有全新身份可以保存未启动证明；旧行缺少证据时保持未知。
			_, _ = execProjectRuntime(m.ctx, m.ledger.db, `INSERT INTO project_runtime_runs(run_id,lease_epoch,state,reason,cleanup_complete) VALUES(?,?,'exited','stopped_before_start',1) ON CONFLICT(run_id) DO NOTHING`, command.RunID, command.LeaseEpoch)
		}
		m.mu.Unlock()
		if command.Type == "project_run_stop" {
			m.signalCleanup()
		}
		return
	}
	var epoch int64
	var state, reason string
	ctx, cancel := context.WithTimeout(m.ctx, time.Second)
	err := m.ledger.db.QueryRowContext(ctx, `SELECT lease_epoch,state,reason FROM project_runtime_runs WHERE run_id=?`, command.RunID).Scan(&epoch, &state, &reason)
	cancel()
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
	if !errors.Is(err, sql.ErrNoRows) {
		m.mu.Unlock()
		return
	}
	if len(m.runs) >= 4 {
		m.mu.Unlock()
		m.report(command, "start_failed", "capacity_exceeded")
		return
	}
	if _, err = execProjectRuntime(m.ctx, m.ledger.db, `INSERT INTO project_runtime_runs(run_id,lease_epoch,state) VALUES(?,?,'starting')`, command.RunID, command.LeaseEpoch); err != nil {
		m.mu.Unlock()
		return
	}
	p := &projectRuntimeProcess{command: command, wake: make(chan struct{}, 1), done: make(chan struct{}), finished: make(chan struct{}), stop: func() {}}
	p.ctx, p.cancel = context.WithCancel(m.ctx)
	m.runs[command.RunID] = p
	m.mu.Unlock()
	defer close(p.finished)
	defer func() {
		p.cancel()
		m.mu.Lock()
		p.stopped = true
		p.cleanupPending = !p.cleanupFailed
		if p.cleanupFailed {
			delete(m.runs, command.RunID)
		}
		m.mu.Unlock()
		if !p.cleanupFailed {
			m.persistCleanup(context.WithoutCancel(m.ctx), p)
		}
	}()
	token := make([]byte, 32)
	if _, err = rand.Read(token); err != nil {
		m.failed(command, "unavailable")
		return
	}
	p.token = hex.EncodeToString(token)
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
	_, _ = execProjectRuntime(m.ctx, m.ledger.db, `UPDATE project_runtime_runs SET state='failed',reason=? WHERE run_id=?`, reason, command.RunID)
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
	defer func() {
		if os.RemoveAll(control) != nil {
			p.cleanupFailed = true
		}
	}()
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
	defer func() {
		if err := os.Remove(endpoint); err != nil && !os.IsNotExist(err) {
			p.cleanupFailed = true
		}
	}()
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
	_, _ = execProjectRuntime(m.ctx, m.ledger.db, `UPDATE project_runtime_runs SET state='running' WHERE run_id=?`, p.command.RunID)
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
	var reports sync.WaitGroup
	defer reports.Wait()
	startedResult := make(chan protocol.ProjectRuntimeResult, 1)
	reports.Add(1)
	go func(result chan<- protocol.ProjectRuntimeResult) {
		defer reports.Done()
		if _, err := m.leaseTime(p); err != nil {
			result <- projectRuntimeFailure("lease_lost")
			return
		}
		result <- m.reportContext(p.ctx, p.command, "started", "")
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
			_, _ = execProjectRuntime(m.ctx, m.ledger.db, `UPDATE project_runtime_runs SET state='exited',reason='runtime_exited' WHERE run_id=?`, p.command.RunID)
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
				reports.Add(1)
				go func() {
					defer reports.Done()
					// 协程恢复执行时也须先核对期限，不能在休眠后先发送续租。
					started, err := m.leaseTime(p)
					if err != nil {
						renewResult <- renewal{clockErr: err}
						return
					}
					renewResult <- renewal{result: m.reportContext(p.ctx, p.command, "renew", ""), started: started}
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
	started, err := m.leaseTime(p)
	if err != nil {
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
			WaitMS       int    `json:"wait_ms"`
			ThreadID     string `json:"thread_id"`
			AfterVersion *int64 `json:"after_version"`
		}
		if len(req.Payload) > 0 {
			if json.Unmarshal(req.Payload, &options) != nil || options.WaitMS < 1 || options.WaitMS > 25000 {
				return result, false
			}
			wait = time.Duration(options.WaitMS) * time.Millisecond
		}
		if options.ThreadID != "" {
			if options.AfterVersion == nil {
				return result, false
			}
			result = m.pollThreadWake(ctx, p, options.ThreadID, *options.AfterVersion, wait)
			break
		}
		if options.AfterVersion != nil {
			return result, false
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
	case "bootstrap", "read_events", "claim_inputs", "append_event", "commit_compaction", "preview", "call_tool", "wait_tool", "report_failure", "finish":
		var call *projectThreadCall
		if req.Operation == "call_tool" || req.Operation == "wait_tool" {
			call = p.beginThreadCall(req.ToolCallID)
		}
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		result = m.call(ctx, req)
		cancel()
		if call != nil {
			result = p.finishThreadCall(call, req, result, started)
		}
		if result.OK && req.Operation == "bootstrap" {
			result = localWaitCapability(result)
		}
	}
	if _, err := m.leaseTime(p); err != nil {
		result = projectRuntimeFailure("lease_lost")
		p.stop()
	}
	return result, result.Code == "lease_lost" || result.OK && (req.Operation == "finish" || req.Operation == "report_failure")
}
