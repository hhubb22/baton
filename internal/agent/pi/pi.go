// Package pi implements the Pi 1.3.0 RPC contract, not terminal output parsing.
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
)

const Version = "1.3.0"

const instructions = `Baton task protocol: the next user message is a JSON task envelope. Follow its description, authorization_scope and expected_outputs; those are limits, not additional authority. Use the baton CLI for delegation and task queries; it uses BATON_CONTEXT_FILE automatically. Do not read or print that file or any credentials. Use a stable request_id when retrying a delegate command. Only operate in the task working directory and explicitly authorized resources. When done, return exactly one JSON object, no Markdown: {"status":"completed","summary":"...","evidence":[],"evidence_empty_reason":"...","artifacts":[],"artifacts_empty_reason":"...","error":null}. Failed results use status failed and error {"code":"execution_failed","message":"..."}. Never invent evidence. If you delegated children and must wait, return exactly {"baton_waiting_for_children":true}; Baton will deliver child results in a later user message. Do not claim completion while children are unprocessed.`

type response struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Command string          `json:"command"`
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Message message         `json:"message"`
	Aborted bool            `json:"aborted"`
}

type Adapter struct {
	config     agent.Config
	history    mapping
	mu         sync.Mutex
	writeMu    sync.Mutex
	cmd        *exec.Cmd
	in         io.WriteCloser
	done       chan struct{}
	pending    map[string]chan response
	sequence   uint64
	active     bool
	waiting    bool
	settled    chan struct{}
	aborting   bool
	usedTools  bool
	final      string
	stopReason string
	outputs    []agent.Output
	closed     bool
	model      string
}

func New(config agent.Config) *Adapter {
	return &Adapter{config: config, pending: make(map[string]chan response)}
}

func (a *Adapter) Start(ctx context.Context) error {
	if a.config.Binary == "" {
		a.config.Binary = "pi"
	}
	if a.config.Model == "" {
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
	version.Env = a.environment()
	raw, err := version.Output()
	if err != nil || strings.TrimSpace(string(raw)) != Version {
		return errors.New("Pi 1.3.0 required; installed CLI version could not be verified")
	}
	args := []string{"--mode", "rpc", "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--session-dir", a.config.SessionDir, "--append-system-prompt", instructions}
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
	cmd.Stderr = io.Discard // Provider diagnostics can contain credentials.
	a.in, err = cmd.StdinPipe()
	if err != nil {
		return errors.New("Pi stdin unavailable")
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return errors.New("Pi stdout unavailable")
	}
	if err := cmd.Start(); err != nil {
		return errors.New("Pi process could not start")
	}
	a.cmd, a.done = cmd, make(chan struct{})
	go func() {
		_ = readFrames(out, a.consume)
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		a.mu.Lock()
		if !a.closed && !a.aborting && (a.active || a.waiting) {
			a.outputs = append(a.outputs, agent.Output{Uncertain: true})
		}
		a.active = false
		a.mu.Unlock()
		close(a.done)
	}()
	fail := func() error { _ = a.Close(); return errors.New("Pi initialization failed") }
	if _, err := a.call(checkCtx, "set_auto_retry", map[string]any{"enabled": false}); err != nil {
		return fail()
	}
	state, err := a.call(checkCtx, "get_state", nil)
	if err != nil {
		return fail()
	}
	var s struct {
		SessionID   string `json:"sessionId"`
		SessionFile string `json:"sessionFile"`
		Model       struct {
			Provider string `json:"provider"`
			ID       string `json:"id"`
		} `json:"model"`
	}
	if json.Unmarshal(state.Data, &s) != nil || s.SessionID != a.config.SessionID || s.SessionFile == "" {
		return fail()
	}
	if a.config.Restore && filepath.Clean(s.SessionFile) != filepath.Clean(a.history.File) {
		return fail()
	}
	if err := a.saveMapping(s.SessionFile); err != nil {
		return fail()
	}
	a.mu.Lock()
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
	if env == nil {
		env = os.Environ()
	}
	result := make([]string, 0, len(env)+3)
	for _, e := range env {
		if !strings.HasPrefix(e, "BATON_CONTEXT_FILE=") && !strings.HasPrefix(e, "PI_OFFLINE=") && !strings.HasPrefix(e, "PI_TELEMETRY=") {
			result = append(result, e)
		}
	}
	return append(result, "BATON_CONTEXT_FILE="+a.config.ContextFile, "PI_OFFLINE=1", "PI_TELEMETRY=0")
}

func (a *Adapter) call(ctx context.Context, command string, fields map[string]any) (response, error) {
	a.mu.Lock()
	a.sequence++
	id := fmt.Sprintf("baton-%d", a.sequence)
	reply := make(chan response, 1)
	a.pending[id] = reply
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
		_ = a.cmd.Process.Kill()
		return response{}, errors.New("Pi command write timed out; outcome uncertain")
	}
	if err != nil {
		return response{}, errors.New("Pi command write not confirmed")
	}
	select {
	case r := <-reply:
		if !r.Success || r.Command != command {
			return r, errors.New("Pi command rejected")
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
	case "tool_execution_start":
		a.usedTools = true
	case "message_end":
		if r.Message.Role == "assistant" {
			a.stopReason = r.Message.StopReason
			a.final = textContent(r.Message.Content)
			if len(a.final) > 256*1024 {
				a.final = ""
			}
		}
	case "agent_settled":
		a.active = false
		close(a.settled)
		if !a.aborting {
			var wait struct {
				Waiting bool `json:"baton_waiting_for_children"`
			}
			_ = json.Unmarshal([]byte(a.final), &wait)
			a.waiting = wait.Waiting
			out := agent.Output{Final: a.final, Exited: true}
			if wait.Waiting {
				out = agent.Output{WaitingForChildren: true}
			}
			if r.Aborted || a.stopReason == "error" || a.stopReason == "aborted" {
				out = agent.Output{Uncertain: true, Exited: true}
			}
			a.outputs = append(a.outputs, out)
		}
	}
	return nil
}

func (a *Adapter) SubmitInput(ctx context.Context, payload string) (agent.Output, error) {
	a.mu.Lock()
	if a.active || a.closed {
		a.mu.Unlock()
		return agent.Output{}, errors.New("Pi Session busy or closed")
	}
	a.active, a.aborting, a.final, a.stopReason, a.waiting = true, false, "", "", false
	a.settled = make(chan struct{})
	a.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	r, err := a.call(ctx, "prompt", map[string]any{"message": payload})
	if err != nil {
		return agent.Output{}, err
	}
	var data struct {
		Disposition string `json:"disposition"`
	}
	if json.Unmarshal(r.Data, &data) != nil || data.Disposition != "started" {
		return agent.Output{}, errors.New("Pi did not start the task prompt")
	}
	return agent.Output{}, nil
}

func (a *Adapter) DeliverResult(ctx context.Context, deliveryID string, payload string) (agent.Output, error) {
	var envelope struct {
		DeliveryID string `json:"delivery_id"`
	}
	if deliveryID == "" || json.Unmarshal([]byte(payload), &envelope) != nil || envelope.DeliveryID != deliveryID {
		return agent.Output{}, errors.New("Pi delivery identity mismatch")
	}
	if found, err := a.HistoryContains(deliveryID, false); err != nil {
		return agent.Output{}, err
	} else if found {
		return agent.Output{}, nil
	}
	return a.SubmitInput(ctx, payload)
}

func (a *Adapter) Drain() []agent.Output {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := a.outputs
	a.outputs = nil
	return out
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
		_ = a.cmd.Process.Kill()
		<-a.done
	}
	return nil
}
