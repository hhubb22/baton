// Package pi implements the Pi RPC contract using structured protocol frames.
package pi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"baton/internal/agent"
	"baton/internal/sidecar"
)

const Version = "1.3.0"

// SupportsVersion 检查 CLI 的最低正式版本，启动后继续校验 RPC 响应。
func SupportsVersion(version string) bool { return agent.CLIVersionAtLeast(version, Version) }

type response struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Command string          `json:"command"`
	Success bool            `json:"success"`
	Error   string          `json:"error"`
	Data    json.RawMessage `json:"data"`
	Message message         `json:"message"`
	Aborted bool            `json:"aborted"`
}

type Adapter struct {
	streamed          bool
	live              agent.LiveBuffer
	config            agent.Config
	diagnostic        *startupDiagnostics
	history           mapping
	mu                sync.Mutex
	writeMu           sync.Mutex
	cmd               *exec.Cmd
	stopProcess       func()
	in                io.WriteCloser
	done              chan struct{}
	pending           map[string]chan response
	sequence          uint64
	active            bool
	settled           chan struct{}
	aborting          bool
	usedTools         bool
	final             string
	stopReason        string
	closed            bool
	model             string
	threadTurn        bool
	threadStarted     bool
	threadMessageID   string
	threadPromptRPCID string
	events            []agent.Event
	intents           map[string]sendIntent
	inputMu           sync.Mutex
	freshHistory      bool
}

var _ agent.Adapter = (*Adapter)(nil)
var _ agent.IntentRestorer = (*Adapter)(nil)
var _ agent.SessionIDProvider = (*Adapter)(nil)

func New(config agent.Config, options ...Option) *Adapter {
	a := &Adapter{config: config, pending: make(map[string]chan response)}
	for _, option := range options {
		option(a)
	}
	return a
}

func (a *Adapter) Start(ctx context.Context) error {
	if a.diagnostic != nil {
		a.diagnostic.configure(a.environment())
	}
	if a.config.Binary == "" {
		a.config.Binary = "pi"
	}
	if a.config.Model == "" && !a.config.Restore {
		a.config.Model = os.Getenv("BATON_PI_MODEL")
	}
	var err error
	a.config.Directory, err = filepath.Abs(a.config.Directory)
	if err != nil {
		return err
	}
	a.config.SessionDir, err = filepath.Abs(a.config.SessionDir)
	if err != nil {
		return err
	}
	if a.config.SessionID == "" {
		return errors.New("Pi Session ID required")
	}
	if info, err := os.Lstat(a.config.SessionDir); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return ErrHistoryMissing
	}
	if err := os.MkdirAll(a.config.SessionDir, 0o700); err != nil {
		return err
	}
	a.config.Directory, err = filepath.EvalSymlinks(a.config.Directory)
	if err != nil {
		return errors.New("Pi working directory unavailable")
	}
	a.config.SessionDir, err = filepath.EvalSymlinks(a.config.SessionDir)
	if err != nil {
		return errors.New("Pi session directory unavailable")
	}
	if a.config.Restore {
		if err := a.loadMapping(); err != nil {
			return err
		}
	} else {
		entries, err := os.ReadDir(a.config.SessionDir)
		if err != nil || len(entries) != 0 {
			return ErrHistoryMissing
		}
	}
	checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	version := exec.CommandContext(checkCtx, a.config.Binary, "--version")
	version.Dir, version.Env = a.config.Directory, a.environment()
	a.captureStderr(version, "version")
	raw, err := version.Output()
	a.recordExit(version, err)
	if err != nil {
		return fmt.Errorf("Pi version check failed: %w", err)
	}
	if !SupportsVersion(strings.TrimSpace(string(raw))) {
		return fmt.Errorf("Pi %s or newer stable version required", Version)
	}
	prompt := fmt.Sprintf(threadInstructions, a.config.Directory)
	args := []string{"--mode", "rpc", "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--session-dir", a.config.SessionDir, "--append-system-prompt", prompt}
	if a.config.Restore {
		args = append(args, "--session", a.history.File)
	} else {
		args = append(args, "--session-id", a.config.SessionID)
	}
	if a.config.Model != "" {
		args = append(args, "--model", a.config.Model)
	}
	cmd := exec.Command(a.config.Binary, args...)
	cmd.Dir, cmd.Env = a.config.Directory, a.environment()
	a.captureStderr(cmd, "rpc")
	a.in, err = cmd.StdinPipe()
	if err != nil {
		return errors.New("Pi stdin unavailable")
	}
	out, output, err := os.Pipe()
	if err != nil {
		_ = a.in.Close()
		return errors.New("Pi stdout unavailable")
	}
	// 独立持有读端，Wait 不会在协议协程读完最后一帧前关闭它。
	cmd.Stdout = output
	cmd.WaitDelay = time.Second
	stop, err := sidecar.StartTree(cmd)
	_ = output.Close()
	if err != nil {
		_ = a.in.Close()
		_ = out.Close()
		a.recordExit(cmd, err)
		return fmt.Errorf("Pi process could not start: %w", err)
	}
	a.cmd, a.stopProcess, a.done = cmd, sync.OnceFunc(stop), make(chan struct{})
	waited := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		a.stopProcess()
		waited <- err
	}()
	go func() {
		defer out.Close()
		readErr := readFrames(out, a.consume)
		var waitErr error
		if a.diagnostic != nil && readErr == nil {
			// 诊断保留自然退出的真实状态，超时再回收进程树。
			select {
			case waitErr = <-waited:
			case <-time.After(250 * time.Millisecond):
				a.diagnostic.markCleanupKill()
				a.stopProcess()
				waitErr = <-waited
			}
		} else {
			if a.diagnostic != nil {
				a.diagnostic.markCleanupKill()
			}
			a.stopProcess()
			waitErr = <-waited
		}
		a.recordExit(cmd, waitErr)
		a.mu.Lock()

		a.processExitedLocked(readErr)
		a.active = false
		a.mu.Unlock()
		close(a.done)
	}()
	fail := func(stage string, cause error) error {
		_ = a.Close()
		return fmt.Errorf("Pi initialization failed (%s): %w", stage, cause)
	}
	if _, err := a.call(checkCtx, "set_auto_retry", map[string]any{"enabled": false}); err != nil {
		return fail("set_auto_retry", err)
	}
	state, err := a.call(checkCtx, "get_state", nil)
	if err != nil {
		return fail("get_state", err)
	}
	var s struct {
		SessionID   string `json:"sessionId"`
		SessionFile string `json:"sessionFile"`
		Model       struct {
			Provider string `json:"provider"`
			ID       string `json:"id"`
		} `json:"model"`
	}
	if err := json.Unmarshal(state.Data, &s); err != nil {
		return fail("get_state decode", err)
	}
	if s.SessionID != a.config.SessionID || s.SessionFile == "" {
		return fail("get_state validation", errors.New("Pi session ID mismatched or session file missing"))
	}
	if a.config.Restore && filepath.Clean(s.SessionFile) != filepath.Clean(a.history.File) {
		return fail("get_state validation", ErrHistoryMissing)
	}
	if err := a.saveMapping(s.SessionFile); err != nil {
		return fail("save native mapping", err)
	}
	a.mu.Lock()
	a.freshHistory = !a.config.Restore
	if s.Model.ID != "" {
		a.model = s.Model.Provider + "/" + s.Model.ID
	}
	a.mu.Unlock()
	return nil
}

// Model reports the provider/model selected by Pi, never auth or full state.
func (a *Adapter) Model() string { a.mu.Lock(); defer a.mu.Unlock(); return a.model }

func (a *Adapter) environment() []string {
	env := a.config.Env
	if env == nil && a.config.Home != "" {
		env = IsolatedEnv(a.config.Home)
	}
	if env == nil {
		env = os.Environ()
	}
	result := make([]string, 0, len(env)+2)
	for _, e := range env {
		if !strings.HasPrefix(e, "PI_OFFLINE=") && !strings.HasPrefix(e, "PI_TELEMETRY=") {
			result = append(result, e)
		}
	}
	return append(result, "PI_OFFLINE=1", "PI_TELEMETRY=0")
}

func (a *Adapter) call(ctx context.Context, command string, fields map[string]any) (response, error) {
	a.mu.Lock()
	a.sequence++
	id := fmt.Sprintf("baton-%d", a.sequence)
	reply := make(chan response, 1)
	a.pending[id] = reply
	if command == "prompt" && a.threadTurn && !a.threadStarted {
		a.threadPromptRPCID = id
	}
	a.mu.Unlock()
	defer func() { a.mu.Lock(); delete(a.pending, id); a.mu.Unlock() }()
	if fields == nil {
		fields = make(map[string]any)
	}
	fields["id"], fields["type"] = id, command
	raw, err := json.Marshal(fields)
	if err != nil {
		return response{}, err
	}
	written := make(chan error, 1)
	go func() {
		a.writeMu.Lock()
		defer a.writeMu.Unlock()
		_, err := a.in.Write(append(raw, '\n'))
		written <- err
	}()
	select {
	case err = <-written:
	case <-ctx.Done():
		if a.diagnostic != nil {
			a.diagnostic.markCleanupKill()
		}
		a.stopProcess()
		return response{}, errors.New("Pi command write timed out; outcome uncertain")
	}
	if err != nil {
		return response{}, fmt.Errorf("Pi command write not confirmed: %w", err)
	}
	select {
	case r := <-reply:
		if !r.Success || r.Command != command {
			return r, fmt.Errorf("Pi command rejected: %s", r.Error)
		}
		return r, nil
	case <-ctx.Done():
		return response{}, errors.New("Pi command response timed out")
	case <-a.done:
		return response{}, errors.New("Pi process exited without confirmation")
	}
}

func (a *Adapter) consume(raw []byte) error {
	var r response
	if json.Unmarshal(raw, &r) != nil {
		return errors.New("invalid Pi frame")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.Type == "response" {
		a.acceptThreadPromptLocked(r)
		if ch := a.pending[r.ID]; ch != nil {
			select {
			case ch <- r:
			default:
			}
		}
		return nil
	}
	if !a.active {
		return nil
	}
	switch r.Type {
	case "message_start":
		a.streamed = false
	case "message_update":
		var event struct {
			Event struct {
				Type  string `json:"type"`
				Delta string `json:"delta"`
			} `json:"assistantMessageEvent"`
		}
		if json.Unmarshal(raw, &event) == nil && event.Event.Type == "text_delta" {
			a.live.Append(event.Event.Delta)
			a.streamed = true
		}
	case "tool_execution_start":
		a.live.Append("\n[工具开始]\n")
		a.usedTools = true
	case "message_end":
		if r.Message.Role == "assistant" {
			a.stopReason = r.Message.StopReason
			a.final = textContent(r.Message.Content)
			if a.threadTurn && a.final != "" {
				a.events = append(a.events, agent.Event{Kind: agent.EventReply, Content: a.final})
			}
			if !a.streamed {
				a.live.Append(a.final)
			}
			if len(a.final) > 256*1024 {
				a.final = ""
			}
		}
	case "agent_settled":
		a.endThreadTurnLocked(r)
		a.active = false
		close(a.settled)
	}
	return nil
}

func (a *Adapter) StopStatus() (bool, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.aborting {
		select {
		case <-a.settled:
			return true, !a.usedTools
		default:
		}
	}
	return false, false
}

func (a *Adapter) Abort() (bool, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	a.mu.Lock()
	if a.done == nil || a.closed {
		a.mu.Unlock()
		return false, false, errors.New("Pi process not running")
	}
	active, settled := a.active, a.settled
	a.aborting = true
	a.mu.Unlock()
	if _, err := a.call(ctx, "clear_queue", nil); err != nil {
		return false, false, err
	}
	if _, err := a.call(ctx, "abort", nil); err != nil {
		return false, false, err
	}
	if active {
		select {
		case <-settled:
		case <-ctx.Done():
			return false, false, errors.New("Pi abort not settled")
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return !a.active, !a.usedTools, nil
}

func (a *Adapter) Close() error {
	a.mu.Lock()
	a.closed = true
	a.mu.Unlock()
	if a.in == nil || a.done == nil {
		return nil
	}
	_ = a.in.Close()
	select {
	case <-a.done:
	case <-time.After(2 * time.Second):
		if a.diagnostic != nil {
			a.diagnostic.markCleanupKill()
		}
		a.stopProcess()
		<-a.done
	}
	return nil
}

func (a *Adapter) DrainLive() (string, bool) { return a.live.Drain() }
