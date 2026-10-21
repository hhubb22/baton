// Package kiro 实现 Kiro CLI V3 的 ACP 会话与一次输入语义。
package kiro

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"baton/internal/agent"
	"baton/internal/privatefile"
	"baton/internal/task"
	"github.com/sourcegraph/jsonrpc2"
)

const Version = "2.32.0"

var (
	ErrIncompatible = errors.New("Kiro ACP 能力或版本不兼容")
	ErrBusy         = errors.New("Kiro 回合仍在运行")
	ErrUncertain    = errors.New("Kiro 输入结果未知，拒绝重发")
)

const instructions = `Baton task protocol: follow the JSON task envelope description, authorization_scope and expected_outputs. Only operate in authorized resources. Return exactly one JSON object without Markdown: {"status":"completed","summary":"...","evidence":[],"evidence_empty_reason":"...","artifacts":[],"artifacts_empty_reason":"...","error":null}. Do not invent evidence. Failed results use status failed and error {"code":"execution_failed","message":"..."}. If waiting for children, return exactly {"baton_waiting_for_children":true}; Baton delivers results in a later message. Finish only after all children are processed.`

type State struct {
	Version    string   `json:"version"`
	NativeID   string   `json:"native_id"`
	SessionID  string   `json:"session_id"`
	Directory  string   `json:"directory"`
	Pending    bool     `json:"pending"`
	Operations []string `json:"operations"`
}

type Adapter struct {
	config                               agent.Config
	mu                                   sync.Mutex
	sendMu                               sync.Mutex
	state                                State
	conn                                 *jsonrpc2.Conn
	processDone                          chan struct{}
	closed                               bool
	active, stopped, usedTools, aborting bool
	final                                string
	finalOverflow                        bool
	transitioning                        bool
	settled                              chan struct{}
	queryConfirmed                       map[string]bool
	queryObserved                        map[string]bool
	queuedFinal                          *agent.Output
	queuedFinalAt                        time.Time
	queryIDs                             map[string]bool
	queryDone                            chan struct{}
	queryChecking                        bool
	queryLast                            time.Time
	queryCtx                             context.Context
	queryCancel                          context.CancelFunc
	queryWG                              sync.WaitGroup
	collecting                           bool
	threadMode                           bool
	threadMessageID                      string
	threadReply                          replyBuffer
	threadEvents                         []agent.Event
	intents                              map[string]sendIntent
	history                              []json.RawMessage
	historyBytes                         int
	historyOverflow                      bool
	outputs                              []agent.Output
	live                                 agent.LiveBuffer
}

var _ agent.Adapter = (*Adapter)(nil)
var _ agent.StopObserver = (*Adapter)(nil)
var _ agent.LiveAdapter = (*Adapter)(nil)
var _ agent.InputAdapter = (*Adapter)(nil)

func New(c agent.Config) *Adapter {
	if dir, err := filepath.EvalSymlinks(c.Directory); err == nil {
		c.Directory = filepath.Clean(dir)
	}
	if c.Binary == "" {
		c.Binary = "kiro-cli"
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Adapter{config: c, queryCtx: ctx, queryCancel: cancel, queryConfirmed: map[string]bool{}, queryIDs: map[string]bool{}, queryObserved: map[string]bool{}}
}

func (a *Adapter) environment() []string {
	env := slices.Clone(a.config.Env)
	if env == nil {
		for _, key := range []string{"PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "COMSPEC", "PATHEXT", "LANG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"} {
			if v, ok := os.LookupEnv(key); ok {
				env = append(env, key+"="+v)
			}
		}
	}
	if a.config.Home != "" {
		env = append(env, "HOME="+a.config.Home, "USERPROFILE="+a.config.Home)
	}
	return env
}

func (a *Adapter) call(ctx context.Context, method string, params, result any) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := a.conn.Call(ctx, method, params, result); err != nil {
		return errors.New("Kiro " + method + " 失败；不自动重试")
	}
	return nil
}

type discardLogger struct{}

func (discardLogger) Printf(string, ...any) {}

func (a *Adapter) connect(ctx context.Context) error {
	if a.conn != nil {
		return nil
	}
	cmd := exec.CommandContext(ctx, a.config.Binary, "--version")
	cmd.Dir, cmd.Env = a.config.Directory, a.environment()
	raw, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(raw)) != "kiro-cli "+Version {
		return ErrIncompatible
	}
	cmd = exec.Command(a.config.Binary, "acp", "--agent-engine=v3")
	cmd.Dir, cmd.Env, cmd.Stderr = a.config.Directory, a.environment(), io.Discard
	cmd.WaitDelay = 2 * time.Second
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		out.Close()
		return err
	}
	if err = cmd.Start(); err != nil {
		out.Close()
		in.Close()
		return errors.New("Kiro ACP 无法启动")
	}
	a.processDone = make(chan struct{})
	a.conn = jsonrpc2.NewConn(context.Background(), jsonrpc2.NewBufferedStream(&processIO{ReadCloser: out, WriteCloser: in, cmd: cmd}, lineCodec{}), jsonrpc2.HandlerWithError(a.handle), jsonrpc2.SetLogger(discardLogger{}))
	conn := a.conn
	go func() { _ = cmd.Wait(); close(a.processDone); _ = conn.Close() }()
	go func() {
		<-conn.DisconnectNotify()
		a.mu.Lock()
		defer a.mu.Unlock()
		if !a.closed && a.threadMode {
			if a.active {
				a.flushReplyLocked()
				a.threadEventLocked(agent.Event{Kind: agent.EventUncertain})
			}
			a.threadEventLocked(agent.Event{Kind: agent.EventExited})
		}
		if !a.closed && a.active {
			a.emitLocked(agent.Output{Uncertain: true})
		}
	}()
	var init struct {
		ProtocolVersion int `json:"protocolVersion"`
		Capabilities    struct {
			Load     bool `json:"loadSession"`
			Sessions struct {
				List json.RawMessage `json:"list"`
			} `json:"sessionCapabilities"`
			Meta struct {
				Kiro struct {
					Methods []string `json:"extensionMethods"`
				} `json:"kiro"`
			} `json:"_meta"`
		} `json:"agentCapabilities"`
	}
	if err = a.call(ctx, "initialize", map[string]any{"protocolVersion": 1, "clientInfo": map[string]string{"name": "baton", "version": "1"}, "clientCapabilities": map[string]any{}}, &init); err != nil {
		return err
	}
	if init.ProtocolVersion != 1 || !init.Capabilities.Load || len(init.Capabilities.Sessions.List) == 0 || !slices.Contains(init.Capabilities.Meta.Kiro.Methods, "_kiro/session/history") {
		return ErrIncompatible
	}
	return nil
}

func (a *Adapter) saveLocked() error {
	raw, err := json.Marshal(a.state)
	if err != nil {
		return err
	}
	return privatefile.WriteFile(a.config.StatePath, raw)
}

func (a *Adapter) Start(ctx context.Context) error {
	if a.config.SessionID == "" || a.config.StatePath == "" {
		return agent.ErrHistoryMissing
	}
	if a.config.Restore {
		return a.attach(ctx)
	}
	if _, err := os.Lstat(a.config.StatePath); !os.IsNotExist(err) {
		return agent.ErrHistoryMissing
	}
	if info, err := os.Lstat(a.config.SessionDir); err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
		return agent.ErrHistoryMissing
	}
	if err := os.MkdirAll(a.config.SessionDir, 0o700); err != nil {
		return err
	}
	if err := a.connect(ctx); err != nil {
		return err
	}
	p := map[string]any{"cwd": a.config.Directory, "mcpServers": []any{}}
	if a.config.Model != "" {
		p["_meta"] = map[string]any{"kiro": map[string]string{"modelId": a.config.Model}}
	}
	var result struct {
		SessionID string `json:"sessionId"`
	}
	if err := a.call(ctx, "session/new", p, &result); err != nil {
		return err
	}
	if result.SessionID == "" {
		return ErrIncompatible
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.state = State{Version: Version, NativeID: result.SessionID, SessionID: a.config.SessionID, Directory: a.config.Directory}
	return a.saveLocked()
}

func (a *Adapter) loadState() (State, error) {
	var s State
	raw, err := privatefile.ReadSnapshot(a.config.StatePath)
	if err != nil {
		if os.IsNotExist(err) {
			return s, agent.ErrHistoryMissing
		}
		return s, agent.ErrHistoryUnread
	}
	if json.Unmarshal(raw, &s) != nil || s.Version != Version || s.NativeID == "" || s.SessionID != a.config.SessionID || s.Directory != a.config.Directory {
		return s, agent.ErrHistoryMissing
	}
	return s, nil
}

func (a *Adapter) exists(ctx context.Context, id string) error {
	cursor := ""
	seen := map[string]bool{}
	for {
		p := map[string]any{"cwd": a.config.Directory}
		if cursor != "" {
			p["cursor"] = cursor
		}
		var r struct {
			Sessions []struct {
				ID  string `json:"sessionId"`
				Cwd string `json:"cwd"`
			} `json:"sessions"`
			Next string `json:"nextCursor"`
		}
		if err := a.call(ctx, "session/list", p, &r); err != nil {
			return err
		}
		for _, s := range r.Sessions {
			if s.ID == id {
				dir, err := filepath.EvalSymlinks(s.Cwd)
				if err != nil || dir != a.config.Directory {
					return agent.ErrHistoryMissing
				}
				return nil
			}
		}
		if r.Next == "" {
			return agent.ErrHistoryMissing
		}
		if seen[r.Next] {
			return ErrIncompatible
		}
		seen[r.Next] = true
		cursor = r.Next
	}
}

func (a *Adapter) attach(ctx context.Context) error {
	s, err := a.loadState()
	if err != nil {
		return err
	}
	if err = a.connect(ctx); err != nil {
		return err
	}
	if err = a.exists(ctx, s.NativeID); err != nil {
		return err
	}
	a.mu.Lock()
	a.state = s
	a.mu.Unlock()
	var result map[string]any
	// 加载中的回放通知不参与当前任务完成判断。
	if err = a.call(ctx, "session/load", map[string]any{"sessionId": s.NativeID, "cwd": a.config.Directory, "mcpServers": []any{}}, &result); err != nil {
		return err
	}
	if meta, ok := result["_meta"].(map[string]any); ok {
		if id, ok := meta["id"].(string); ok && id != s.NativeID {
			return agent.ErrHistoryMissing
		}
	}
	return nil
}

func (a *Adapter) SubmitInput(ctx context.Context, payload string) (agent.Output, error) {
	var input struct {
		Description string `json:"description"`
		Generation  int    `json:"generation"`
	}
	if len(payload) > task.ExecutorInputLimit || json.Unmarshal([]byte(payload), &input) != nil || input.Description == "" || input.Generation != 1 || a.config.ExecutionID == "" {
		return agent.Output{}, errors.New("Kiro 任务输入无效")
	}
	return agent.Output{}, a.prompt(ctx, a.config.ExecutionID+":1", instructions+"\n"+payload)
}

func (a *Adapter) prompt(ctx context.Context, id, text string) error {
	a.sendMu.Lock()
	defer a.sendMu.Unlock()
	return a.promptLocked(ctx, id, text)
}

func (a *Adapter) promptLocked(ctx context.Context, id, text string) error {
	a.mu.Lock()
	if a.active {
		a.mu.Unlock()
		return ErrBusy
	}
	if a.closed || a.state.NativeID == "" {
		a.mu.Unlock()
		return agent.ErrHistoryMissing
	}
	if id == "" || a.state.Pending || slices.Contains(a.state.Operations, id) {
		a.mu.Unlock()
		return ErrUncertain
	}
	a.state.Pending = true
	a.state.Operations = append(a.state.Operations, id)
	if err := a.saveLocked(); err != nil {
		a.mu.Unlock()
		return err
	}
	a.outputs = nil
	a.queuedFinal = nil
	a.active, a.stopped, a.aborting, a.final = true, false, false, ""
	a.finalOverflow = false
	a.settled = make(chan struct{})
	settled := a.settled
	native := a.state.NativeID
	a.mu.Unlock()
	// 同步完成写入后才返回，保证随后 cancel 的线序位于 prompt 之后。
	waiter, err := a.conn.DispatchCall(ctx, "session/prompt", map[string]any{"sessionId": native, "prompt": []map[string]string{{"type": "text", "text": text}}})
	if err != nil {
		return ErrUncertain
	}
	go func() {
		defer close(settled)
		var result struct {
			StopReason string `json:"stopReason"`
		}
		err := waiter.Wait(context.Background(), &result)
		queriesOK := true
		if err == nil {
			queriesOK = a.confirmQueries()
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.closed {
			return
		}
		a.active = false
		if err != nil {
			a.emitLocked(agent.Output{Uncertain: true})
			return
		}
		switch result.StopReason {
		case "end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal":
		default:
			a.emitLocked(agent.Output{Uncertain: true})
			return
		}
		a.stopped = !a.transitioning
		a.state.Pending = false
		if err := a.saveLocked(); err != nil {
			a.emitLocked(agent.Output{Uncertain: true})
			return
		}
		if a.transitioning {
			return
		}
		out := agent.Output{Exited: true, Uncertain: a.finalOverflow || !queriesOK}
		if result.StopReason == "end_turn" && !a.aborting && !a.finalOverflow && queriesOK {
			var waiting struct {
				Waiting bool `json:"baton_waiting_for_children"`
			}
			if json.Unmarshal([]byte(a.final), &waiting) == nil && waiting.Waiting {
				out.Exited = false
				out.WaitingForChildren = true
			} else {
				out.Final = a.final
			}
		}
		if queriesOK && !a.queriesObservedLocked() {
			a.queuedFinal = &out
			a.queuedFinalAt = time.Now()
		} else {
			a.emitLocked(out)
		}
	}()
	return nil
}

func (a *Adapter) emitLocked(out agent.Output) {
	if len(a.outputs) >= 128 {
		a.outputs = []agent.Output{{Uncertain: true}}
		a.live.MarkGap()
		return
	}
	a.outputs = append(a.outputs, out)
}
func (a *Adapter) Drain() []agent.Output {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.queuedFinal != nil && time.Since(a.queuedFinalAt) >= 10*time.Second {
		a.emitLocked(agent.Output{Exited: true, Uncertain: true})
		a.queuedFinal = nil
	}
	out := a.outputs
	a.outputs = nil
	return out
}
func (a *Adapter) DrainLive() (string, bool) { return a.live.Drain() }
func (a *Adapter) Snapshot() State {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := a.state
	s.Operations = slices.Clone(s.Operations)
	return s
}

// Supplement 沿用 Kiro 活动输入的打断语义，先等旧 prompt 结束再发新输入。
func (a *Adapter) Supplement(ctx context.Context, id, text string) error {
	a.sendMu.Lock()
	defer a.sendMu.Unlock()
	a.mu.Lock()
	if id == "" || slices.Contains(a.state.Operations, id) || a.closed {
		a.mu.Unlock()
		return ErrUncertain
	}
	active := a.active
	if !active {
		a.mu.Unlock()
		return a.promptLocked(ctx, id, text)
	}
	a.transitioning, a.aborting = true, true
	settled, native := a.settled, a.state.NativeID
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.transitioning = false; a.mu.Unlock() }()
	if err := a.conn.Notify(ctx, "session/cancel", map[string]string{"sessionId": native}); err != nil {
		return ErrUncertain
	}
	select {
	case <-ctx.Done():
		return ErrUncertain
	case <-settled:
	}
	a.mu.Lock()
	pending := a.state.Pending
	a.transitioning = false
	a.mu.Unlock()
	if pending {
		return ErrUncertain
	}
	return a.promptLocked(ctx, id, text)
}

func (a *Adapter) Abort() (bool, bool, error) {
	a.sendMu.Lock()
	defer a.sendMu.Unlock()
	a.mu.Lock()
	if a.stopped && !a.active {
		known := !a.usedTools
		a.mu.Unlock()
		return true, known, nil
	}
	if !a.active {
		a.mu.Unlock()
		return false, false, ErrUncertain
	}
	if a.aborting {
		a.mu.Unlock()
		return false, false, nil
	}
	a.aborting = true
	id := a.state.NativeID
	a.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.conn.Notify(ctx, "session/cancel", map[string]string{"sessionId": id}); err != nil {
		return false, false, ErrUncertain
	}
	return false, false, nil
}
func (a *Adapter) StopStatus() (bool, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.stopped, a.stopped && !a.usedTools
}

func (a *Adapter) handle(ctx context.Context, c *jsonrpc2.Conn, r *jsonrpc2.Request) (any, error) {
	var p struct {
		SessionID string `json:"sessionId"`
		Update    struct {
			Kind    string          `json:"sessionUpdate"`
			Content json.RawMessage `json:"content"`
		} `json:"update"`
		Options []struct {
			ID   string `json:"optionId"`
			Kind string `json:"kind"`
		} `json:"options"`
	}
	if r.Params == nil || json.Unmarshal(*r.Params, &p) != nil {
		return nil, &jsonrpc2.Error{Code: jsonrpc2.CodeInvalidParams, Message: "invalid params"}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if p.SessionID != a.state.NativeID {
		if !r.Notif {
			return map[string]any{"outcome": map[string]string{"outcome": "cancelled"}}, nil
		}
		return nil, nil
	}
	if r.Method == "session/request_permission" {
		if a.active && !a.aborting {
			for _, o := range p.Options {
				if o.Kind == "allow_once" {
					return map[string]any{"outcome": map[string]string{"outcome": "selected", "optionId": o.ID}}, nil
				}
			}
		}
		return map[string]any{"outcome": map[string]string{"outcome": "cancelled"}}, nil
	}
	if r.Method != "session/update" {
		if r.Notif {
			return nil, nil
		}
		return nil, &jsonrpc2.Error{Code: jsonrpc2.CodeMethodNotFound, Message: "unsupported client request"}
	}
	if a.collecting || (a.active && (p.Update.Kind == "tool_call" || p.Update.Kind == "tool_call_update")) {
		switch p.Update.Kind {
		case "user_message_chunk", "agent_message_chunk", "tool_call", "tool_call_update":
			if !a.collecting {
				for len(a.history) > 0 && (len(a.history) >= 128 || a.historyBytes+len(*r.Params) > maxFrame) {
					a.historyBytes -= len(a.history[0])
					a.history = a.history[1:]
				}
			}
			if a.historyBytes+len(*r.Params) > maxFrame {
				a.historyOverflow = true
			} else {
				a.history = append(a.history, slices.Clone(*r.Params))
				a.historyBytes += len(*r.Params)
			}
		}
	}
	if !a.active {
		return nil, nil
	}
	if a.threadMode {
		switch p.Update.Kind {
		case "agent_message_chunk":
			var content struct{ Type, Text string }
			if json.Unmarshal(p.Update.Content, &content) == nil && content.Type == "text" {
				a.live.Append(content.Text)
				a.threadReply.append(content.Text)
			}
		case "tool_call", "tool_call_update":
			a.flushReplyLocked()
			a.usedTools = true
		}
		return nil, nil
	}
	switch p.Update.Kind {
	case "agent_message_chunk":
		var content struct{ Type, Text string }
		if json.Unmarshal(p.Update.Content, &content) == nil && content.Type == "text" {
			a.live.Append(content.Text)
			if len(a.final)+len(content.Text) <= task.ExecutorInputLimit {
				a.final += content.Text
			} else {
				a.final = ""
				a.finalOverflow = true
				a.emitLocked(agent.Output{Uncertain: true})
			}
		}
	case "tool_call":
		a.usedTools = true
		a.final = ""
	}
	return nil, nil
}

func (a *Adapter) Close() error {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil
	}
	a.closed = true
	a.queryCancel()
	conn, done := a.conn, a.processDone
	a.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
	a.queryWG.Wait()
	if done != nil {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			return errors.New("Kiro 进程未在关闭期限内退出")
		}
	}
	return nil
}
