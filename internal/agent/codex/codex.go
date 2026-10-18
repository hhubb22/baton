// Package codex implements the pinned Codex app-server thread/turn protocol.
package codex

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"baton/internal/agent"
	"baton/internal/privatefile"
	"github.com/sourcegraph/jsonrpc2"
)

const Version = "0.162.1"

var (
	ErrIncompatible   = errors.New("Codex experimental protocol incompatible; require CLI 0.162.1")
	ErrHistoryMissing = agent.ErrHistoryMissing
	ErrUncertain      = errors.New("Codex input outcome unknown; refusing replay")
	ErrBusy           = errors.New("Codex turn is active")
)

type Config = agent.Config

type Capabilities struct {
	Version                                            string
	Start, Input, Interrupt, Resume, History, Delegate bool
}

// Event is the pinned native protocol evidence used by contract/real probes.
// Worker lifecycle consumers use agent.Adapter.Drain instead.
type Event struct {
	ThreadID, TurnID            string
	Raw                         json.RawMessage
	Final, ConfirmedInput       string
	Stopped, Settled, Uncertain bool
}

type State struct {
	Version     string   `json:"version"`
	ThreadID    string   `json:"thread_id"`
	TurnID      string   `json:"turn_id"`
	Pending     bool     `json:"pending"`
	SessionID   string   `json:"session_id"`
	Directory   string   `json:"directory"`
	OperationID string   `json:"operation_id"`
	SteerID     string   `json:"steer_id"`
	Operations  []string `json:"operations"`
}

type turn struct {
	ID     string            `json:"id"`
	Status string            `json:"status"`
	Items  []json.RawMessage `json:"items"`
}

type Adapter struct {
	config      Config
	mu          sync.Mutex
	state       State
	active      bool
	final       string
	conn        *jsonrpc2.Conn
	processDone chan struct{}
	events      chan Event
	stopped     bool
	closed      chan struct{}
	closeOnce   sync.Once
	inbox       chan notification
}

type notification struct {
	method string
	raw    json.RawMessage
}

var _ agent.Adapter = (*Adapter)(nil)
var _ agent.StopObserver = (*Adapter)(nil)

func New(c Config) *Adapter {
	if directory, err := filepath.EvalSymlinks(c.Directory); err == nil {
		c.Directory = filepath.Clean(directory)
	}
	if c.Binary == "" {
		c.Binary = "codex"
	}
	if c.Model == "" && !c.Restore {
		c.Model = os.Getenv("BATON_CODEX_MODEL")
	}
	a := &Adapter{config: c, events: make(chan Event, 128), closed: make(chan struct{}), inbox: make(chan notification, 128)}
	go func() {
		for {
			select {
			case <-a.closed:
				return
			case n := <-a.inbox:
				a.notification(n.method, n.raw)
			}
		}
	}()
	return a
}

func (a *Adapter) environment() []string {
	env := append([]string(nil), a.config.Env...)
	if a.config.Env == nil {
		for _, key := range []string{"PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "COMSPEC", "PATHEXT", "LANG"} {
			if value, ok := os.LookupEnv(key); ok {
				env = append(env, key+"="+value)
			}
		}
	}
	if a.config.Home != "" {
		env = append(env, "CODEX_HOME="+a.config.Home)
	}
	if a.config.ContextFile != "" {
		env = append(env, "BATON_CONTEXT_FILE="+a.config.ContextFile)
	}
	return env
}

func (a *Adapter) Probe(ctx context.Context) (Capabilities, error) {
	cmd := exec.CommandContext(ctx, a.config.Binary, "--version")
	cmd.Dir = a.config.Directory
	cmd.Env = a.environment()
	raw, err := cmd.Output()
	if err != nil {
		return Capabilities{}, errors.New("Codex executable unavailable")
	}
	if strings.TrimSpace(string(raw)) != "codex-cli "+Version {
		return Capabilities{}, ErrIncompatible
	}
	return Capabilities{Version: Version, Start: true, Input: true, Interrupt: true, Resume: true, History: true, Delegate: true}, nil
}

func (a *Adapter) connect(ctx context.Context) error {
	if a.conn != nil {
		return nil
	}
	if _, err := a.Probe(ctx); err != nil {
		return err
	}
	cmd := exec.Command(a.config.Binary, "app-server", "--stdio")
	cmd.WaitDelay = 2 * time.Second
	cmd.Dir, cmd.Env, cmd.Stderr = a.config.Directory, a.environment(), io.Discard
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		_ = out.Close()
		return err
	}
	if err := cmd.Start(); err != nil {
		_ = out.Close()
		_ = in.Close()
		return errors.New("Codex app-server could not start")
	}
	a.processDone = make(chan struct{})
	p := &processIO{ReadCloser: out, WriteCloser: in, cmd: cmd}
	a.conn = jsonrpc2.NewConn(context.Background(), jsonrpc2.NewBufferedStream(p, lineCodec{}), jsonrpc2.HandlerWithError(a.handle), jsonrpc2.SetLogger(discardLogger{}))
	go func() { _ = cmd.Wait(); close(a.processDone); _ = a.conn.Close() }()
	go func() {
		<-a.conn.DisconnectNotify()
		select {
		case <-a.closed:
			return
		default:
		}
		a.emit(Event{Uncertain: true})
	}()
	var result struct {
		UserAgent string `json:"userAgent"`
	}
	if err := a.call(ctx, "initialize", map[string]any{"clientInfo": map[string]string{"name": "baton", "version": "1"}, "capabilities": map[string]bool{"experimentalApi": true}}, &result); err != nil {
		_ = a.Close()
		return err
	}
	if result.UserAgent == "" {
		_ = a.Close()
		return ErrIncompatible
	}
	if err := a.conn.Notify(ctx, "initialized", map[string]any{}); err != nil {
		_ = a.Close()
		return ErrIncompatible
	}
	return nil
}

func (a *Adapter) call(ctx context.Context, method string, params, result any) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := a.conn.Call(ctx, method, params, result); err != nil {
		var rpc *jsonrpc2.Error
		if errors.As(err, &rpc) && (rpc.Code == jsonrpc2.CodeMethodNotFound || rpc.Code == jsonrpc2.CodeInvalidParams) {
			return ErrIncompatible
		}
		return errors.New("Codex " + method + " failed; no automatic retry")
	}
	return nil
}

func (a *Adapter) saveLocked() error {
	if a.config.StatePath == "" {
		return errors.New("Codex state path required")
	}
	raw, err := json.Marshal(a.state)
	if err != nil {
		return err
	}
	return privatefile.WriteFile(a.config.StatePath, raw)
}

func (a *Adapter) CreateSession(ctx context.Context) error {
	if _, err := os.Lstat(a.config.StatePath); !os.IsNotExist(err) {
		return ErrHistoryMissing
	}
	if err := a.connect(ctx); err != nil {
		return err
	}
	var response struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	p := map[string]any{"cwd": a.config.Directory, "approvalPolicy": "never", "sandbox": "workspace-write", "historyMode": "paginated", "ephemeral": false, "developerInstructions": Instructions}
	p["config"] = map[string]any{"sandbox_workspace_write.network_access": true, "shell_environment_policy.inherit": "all"}
	if a.config.Model != "" {
		p["model"] = a.config.Model
	}
	if err := a.call(ctx, "thread/start", p, &response); err != nil {
		return err
	}
	if response.Thread.ID == "" {
		return ErrIncompatible
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.state = State{Version: Version, ThreadID: response.Thread.ID, SessionID: a.config.SessionID, Directory: a.config.Directory}
	return a.saveLocked()
}

func (a *Adapter) Attach(ctx context.Context) error {
	raw, err := privatefile.ReadFile(a.config.StatePath)
	if err != nil {
		return ErrHistoryMissing
	}
	var s State
	if json.Unmarshal(raw, &s) != nil || s.Version != Version || s.ThreadID == "" {
		return ErrIncompatible
	}
	if s.SessionID != a.config.SessionID || s.Directory != a.config.Directory {
		return ErrHistoryMissing
	}
	if err := a.connect(ctx); err != nil {
		return err
	}
	var read struct {
		Thread struct {
			ID  string `json:"id"`
			Cwd string `json:"cwd"`
		} `json:"thread"`
	}
	if err := a.call(ctx, "thread/read", map[string]any{"threadId": s.ThreadID}, &read); err != nil {
		return err
	}
	directory, err := filepath.EvalSymlinks(read.Thread.Cwd)
	if err != nil || !filepath.IsAbs(read.Thread.Cwd) || read.Thread.ID != s.ThreadID || filepath.Clean(directory) != a.config.Directory {
		return ErrHistoryMissing
	}
	var original *turn
	if s.TurnID != "" {
		cursor := ""
		seen := map[string]bool{}
		for {
			var page struct {
				Data       []turn `json:"data"`
				NextCursor string `json:"nextCursor"`
			}
			if err := a.call(ctx, "thread/turns/list", map[string]any{"threadId": s.ThreadID, "cursor": cursorOrNil(cursor), "limit": 32}, &page); err != nil {
				return err
			}
			for _, t := range page.Data {
				if t.ID == s.TurnID {
					value := t
					original = &value
					break
				}
			}
			if original != nil || page.NextCursor == "" {
				break
			}
			if seen[page.NextCursor] {
				return ErrIncompatible
			}
			seen[page.NextCursor] = true
			cursor = page.NextCursor
		}
		if original == nil {
			return ErrHistoryMissing
		}
	} else if s.Pending {
		return ErrUncertain
	}
	var resumed struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	p := map[string]any{"threadId": s.ThreadID, "excludeTurns": true, "approvalPolicy": "never", "sandbox": "workspace-write", "cwd": a.config.Directory}
	p["config"] = map[string]any{"sandbox_workspace_write.network_access": true, "shell_environment_policy.inherit": "all"}
	if a.config.Model != "" {
		p["model"] = a.config.Model
	}
	if err := a.call(ctx, "thread/resume", p, &resumed); err != nil {
		return err
	}
	if resumed.Thread.ID != s.ThreadID {
		return ErrHistoryMissing
	}
	a.mu.Lock()
	a.state = s
	if original != nil {
		a.active = original.Status == "inProgress"
	}
	a.mu.Unlock()
	if original != nil && original.Status != "inProgress" {
		// Read final items too: paginated turn records need not embed them.
		seenCursor := map[string]bool{}
		page, err := a.ReadHistory(ctx, "")
		if err != nil {
			return err
		}
		for {
			var items []struct {
				TurnID string          `json:"turnId"`
				Item   json.RawMessage `json:"item"`
			}
			if json.Unmarshal(page.Data, &items) != nil {
				return ErrIncompatible
			}
			for _, item := range items {
				if item.TurnID == s.TurnID {
					original.Items = append(original.Items, item.Item)
				}
			}
			if page.NextCursor == "" {
				break
			}
			if seenCursor[page.NextCursor] {
				return ErrIncompatible
			}
			seenCursor[page.NextCursor] = true
			page, err = a.ReadHistory(ctx, page.NextCursor)
			if err != nil {
				return err
			}
		}
		if s.SteerID != "" {
			found := false
			for _, raw := range original.Items {
				var item struct{ Type, ClientID string }
				if json.Unmarshal(raw, &item) == nil && item.Type == "userMessage" && item.ClientID == s.SteerID {
					found = true
				}
			}
			if !found {
				return ErrUncertain
			}
		}
		if original.Status == "completed" {
			found := false
			for _, raw := range original.Items {
				var item struct{ Type, Text, Phase string }
				if json.Unmarshal(raw, &item) == nil && item.Type == "agentMessage" && item.Phase != "commentary" && item.Text != "" {
					found = true
				}
			}
			if !found {
				return ErrHistoryMissing
			}
		}
		raw, _ := json.Marshal(map[string]any{"threadId": s.ThreadID, "turn": original})
		a.notification("turn/completed", raw)
	}
	return nil
}

func textInput(text string) []map[string]any {
	return []map[string]any{{"type": "text", "text": text, "text_elements": []any{}}}
}

func (a *Adapter) StartTask(ctx context.Context, operationID, text string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.active {
		return ErrBusy
	}
	if a.state.Pending || a.state.SteerID != "" {
		return ErrUncertain
	}
	if a.usedLocked(operationID) {
		return ErrUncertain
	}
	if a.state.ThreadID == "" || operationID == "" {
		return ErrHistoryMissing
	}
	a.state.Pending = true
	a.state.OperationID, a.state.TurnID = operationID, ""
	a.state.Operations = append(a.state.Operations, operationID)
	if err := a.saveLocked(); err != nil {
		return err
	}
	var result struct {
		Turn turn `json:"turn"`
	}
	p := map[string]any{"threadId": a.state.ThreadID, "input": textInput(text), "clientUserMessageId": operationID, "outputSchema": ResultSchema()}
	if a.config.Model != "" {
		p["model"] = a.config.Model
	}
	if err := a.call(ctx, "turn/start", p, &result); err != nil {
		return err
	}
	if result.Turn.ID == "" || (result.Turn.Status != "inProgress" && result.Turn.Status != "completed" && result.Turn.Status != "interrupted" && result.Turn.Status != "failed") {
		return ErrIncompatible
	}
	a.state.TurnID, a.active, a.final, a.stopped = result.Turn.ID, true, "", false
	if err := a.saveLocked(); err != nil {
		return err
	}
	if result.Turn.Status != "inProgress" {
		raw, _ := json.Marshal(map[string]any{"threadId": a.state.ThreadID, "turn": result.Turn})
		select {
		case a.inbox <- notification{"turn/completed", raw}:
		default:
			return ErrUncertain
		}
	}
	return nil
}

func (a *Adapter) SendInput(ctx context.Context, operationID, text string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.active || a.state.Pending == false {
		return ErrBusy
	}
	if operationID == "" || a.state.SteerID != "" || a.usedLocked(operationID) {
		return ErrUncertain
	}
	a.state.SteerID = operationID
	a.state.Operations = append(a.state.Operations, operationID)
	if err := a.saveLocked(); err != nil {
		return err
	}
	var result struct {
		TurnID string `json:"turnId"`
	}
	if err := a.call(ctx, "turn/steer", map[string]any{"threadId": a.state.ThreadID, "expectedTurnId": a.state.TurnID, "input": textInput(text), "clientUserMessageId": operationID}, &result); err != nil {
		return err
	}
	if result.TurnID != a.state.TurnID {
		return ErrIncompatible
	}
	return nil
}

func (a *Adapter) usedLocked(id string) bool {
	for _, used := range a.state.Operations {
		if id == used {
			return true
		}
	}
	return id == a.state.OperationID
}

func (a *Adapter) Interrupt(ctx context.Context) (bool, bool, error) {
	a.mu.Lock()
	id, tid, active := a.state.ThreadID, a.state.TurnID, a.active
	a.mu.Unlock()
	if !active {
		return false, false, ErrBusy
	}
	var result map[string]any
	err := a.call(ctx, "turn/interrupt", map[string]any{"threadId": id, "turnId": tid}, &result)
	// The ACK is not evidence of stopped shells or a known operation outcome.
	return false, false, err
}

func (a *Adapter) ReadHistory(ctx context.Context, cursor string) (agent.HistoryPage, error) {
	a.mu.Lock()
	id := a.state.ThreadID
	a.mu.Unlock()
	if id == "" {
		return agent.HistoryPage{}, ErrHistoryMissing
	}
	var result struct {
		Data       json.RawMessage `json:"data"`
		NextCursor string          `json:"nextCursor"`
	}
	if err := a.call(ctx, "thread/items/list", map[string]any{"threadId": id, "cursor": cursorOrNil(cursor), "limit": 16, "sortDirection": "asc"}, &result); err != nil {
		return agent.HistoryPage{}, err
	}
	if len(result.Data) == 0 {
		return agent.HistoryPage{}, ErrIncompatible
	}
	return agent.HistoryPage{Data: result.Data, NextCursor: result.NextCursor}, nil
}

func cursorOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func (a *Adapter) Events() <-chan Event { return a.events }
func (a *Adapter) Snapshot() State      { a.mu.Lock(); defer a.mu.Unlock(); return a.state }

func (a *Adapter) emit(e Event) {
	select {
	case a.events <- e:
	default:
		select {
		case <-a.events:
		default:
		}
		select {
		case a.events <- Event{Uncertain: true}:
		default:
		}
		go a.Close()
	}
}

func (a *Adapter) handle(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) (any, error) {
	if !req.Notif {
		return nil, &jsonrpc2.Error{Code: jsonrpc2.CodeMethodNotFound, Message: "Baton refuses unattended approval/auth/tool requests"}
	}
	if req.Method != "item/completed" && req.Method != "turn/completed" {
		return nil, nil
	}
	if req.Params == nil {
		return nil, nil
	}
	// Never hold the reader loop on the caller's StartTask mutex.
	params := append(json.RawMessage(nil), (*req.Params)...)
	select {
	case a.inbox <- notification{req.Method, params}:
	default:
		a.emit(Event{Uncertain: true})
		go a.Close()
	}
	return nil, nil
}

func (a *Adapter) notification(method string, raw json.RawMessage) {
	if method != "item/completed" && method != "turn/completed" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var p struct {
		ThreadID string                                       `json:"threadId"`
		TurnID   string                                       `json:"turnId"`
		Turn     turn                                         `json:"turn"`
		Item     struct{ Type, Text, Phase, ClientID string } `json:"item"`
	}
	if json.Unmarshal(raw, &p) != nil || a.state.ThreadID == "" || p.ThreadID != a.state.ThreadID {
		return
	}
	if method == "item/completed" && p.TurnID != a.state.TurnID {
		return
	}
	e := Event{ThreadID: p.ThreadID, TurnID: p.TurnID, Raw: raw}
	if method == "item/completed" && p.TurnID == a.state.TurnID && p.Item.Type == "userMessage" && p.Item.ClientID != "" && (p.Item.ClientID == a.state.SteerID || a.usedLocked(p.Item.ClientID)) {
		e.ConfirmedInput = p.Item.ClientID
		if p.Item.ClientID == a.state.SteerID {
			a.state.SteerID = ""
		}
		if a.saveLocked() != nil {
			e.ConfirmedInput = ""
			e.Uncertain = true
		}
	}
	if method == "item/completed" && p.TurnID == a.state.TurnID && p.Item.Type == "agentMessage" && p.Item.Phase != "commentary" {
		a.final = p.Item.Text
	}
	if method == "turn/completed" {
		if p.Turn.ID != a.state.TurnID {
			return
		}
		if p.Turn.Status != "completed" && p.Turn.Status != "interrupted" && p.Turn.Status != "failed" {
			e.Uncertain = true
		} else {
			a.active = false
			a.stopped = true
			e.Stopped = true
			a.state.Pending = false
			if err := a.saveLocked(); err != nil {
				e.Uncertain = true
			} else {
				e.Settled = true
			}
		}
		// Persisted turn items are authoritative, not deltas or process exit.
		for _, rawItem := range p.Turn.Items {
			var item struct{ Type, Text, Phase, ClientID string }
			if json.Unmarshal(rawItem, &item) == nil && item.Type == "userMessage" && item.ClientID != "" && (item.ClientID == a.state.SteerID || a.usedLocked(item.ClientID)) {
				a.emit(Event{ThreadID: p.ThreadID, TurnID: p.Turn.ID, ConfirmedInput: item.ClientID})
				if item.ClientID == a.state.SteerID {
					a.state.SteerID = ""
				}
				if a.saveLocked() != nil {
					e.Uncertain = true
					e.Settled = false
				}
			}
			if json.Unmarshal(rawItem, &item) == nil && item.Type == "agentMessage" && item.Phase != "commentary" {
				a.final = item.Text
			}
		}
		e.TurnID = p.Turn.ID
		if a.state.SteerID != "" {
			e.Settled = false
			e.Uncertain = true
		}
		if p.Turn.Status == "completed" {
			e.Final = a.final
			if e.Final == "" {
				e.Uncertain = true
				e.Settled = false
			}
		} else {
			e.Uncertain = true
			e.Settled = false
		}
	}
	a.emit(e)
}

func (a *Adapter) Close() error {
	a.closeOnce.Do(func() {
		close(a.closed)
		if a.conn != nil {
			_ = a.conn.Close()
		}
		if a.processDone != nil {
			<-a.processDone
		}
	})
	return nil
}

type discardLogger struct{}

func (discardLogger) Printf(string, ...any) {}
