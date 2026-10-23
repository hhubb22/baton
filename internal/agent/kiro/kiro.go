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
	"baton/internal/sidecar"

	"github.com/sourcegraph/jsonrpc2"
)

const Version = "2.32.0"

// SupportsVersion 检查 CLI 的最低正式版本，启动后继续校验 ACP 能力。
func SupportsVersion(version string) bool { return agent.CLIVersionAtLeast(version, Version) }

var (
	ErrIncompatible = errors.New("Kiro ACP 能力或版本不兼容")
	ErrBusy         = errors.New("Kiro 回合仍在运行")
	ErrUncertain    = errors.New("Kiro 输入结果未知，拒绝重发")
)

type State struct {
	Version    string   `json:"version"`
	NativeID   string   `json:"native_id"`
	SessionID  string   `json:"session_id"`
	Directory  string   `json:"directory"`
	Model      string   `json:"model,omitempty"`
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
	settled                              chan struct{}
	collecting                           bool
	threadMessageID                      string
	threadReply                          replyBuffer
	threadEvents                         []agent.Event
	intents                              map[string]sendIntent
	history                              []json.RawMessage
	historyBytes                         int
	historyOverflow                      bool
	live                                 agent.LiveBuffer
}

var _ agent.Adapter = (*Adapter)(nil)
var _ agent.LiveAdapter = (*Adapter)(nil)

func New(c agent.Config) *Adapter {
	if dir, err := filepath.EvalSymlinks(c.Directory); err == nil {
		c.Directory = filepath.Clean(dir)
	}
	if c.Binary == "" {
		c.Binary = "kiro-cli"
	}
	return &Adapter{config: c}
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
	version, found := strings.CutPrefix(strings.TrimSpace(string(raw)), "kiro-cli ")
	if err != nil || !found || !SupportsVersion(version) {
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
	stopTree, err := sidecar.StartTree(cmd)
	if err != nil {
		out.Close()
		in.Close()
		return errors.New("Kiro ACP 无法启动")
	}
	stopTree = sync.OnceFunc(stopTree)
	a.processDone = make(chan struct{})
	a.conn = jsonrpc2.NewConn(context.Background(), jsonrpc2.NewBufferedStream(&processIO{ReadCloser: out, WriteCloser: in, stopTree: stopTree}, lineCodec{}), jsonrpc2.HandlerWithError(a.handle), jsonrpc2.SetLogger(discardLogger{}))
	conn := a.conn
	go func() {
		_ = cmd.Wait()
		stopTree()
		close(a.processDone)
		_ = conn.Close()
	}()
	go func() {
		<-conn.DisconnectNotify()
		a.mu.Lock()
		defer a.mu.Unlock()
		if !a.closed {
			if a.active {
				a.flushReplyLocked()
				a.threadEventLocked(agent.Event{Kind: agent.EventUncertain})
			}
			a.threadEventLocked(agent.Event{Kind: agent.EventExited})
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
	result, err := a.newSession(ctx)
	if err != nil {
		return err
	}
	if result.SessionID == "" {
		return ErrIncompatible
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if model := result.catalog().DefaultModel; model != "" {
		a.config.Model = model
	}
	a.state = State{Model: a.config.Model, Version: Version, NativeID: result.SessionID, SessionID: a.config.SessionID, Directory: a.config.Directory}
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
	if s.Model != "" {
		a.config.Model = s.Model
	}
	a.mu.Unlock()
	var result map[string]any
	// 加载中的回放通知不形成新 Turn 的回复。
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

func (a *Adapter) DrainLive() (string, bool) { return a.live.Drain() }
func (a *Adapter) Snapshot() State {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := a.state
	s.Operations = slices.Clone(s.Operations)
	return s
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

func (a *Adapter) Close() error {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil
	}
	a.closed = true
	conn, done := a.conn, a.processDone
	a.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			return errors.New("Kiro 进程未在关闭期限内退出")
		}
	}
	return nil
}
