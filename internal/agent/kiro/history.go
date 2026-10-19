package kiro

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"baton/internal/agent"
	"baton/internal/protocol"
	"baton/internal/task"
)

// nativeHistory 通过独立 ACP 连接加载已保存会话，不触碰执行连接或发送 prompt。
func (a *Adapter) nativeHistory(ctx context.Context) ([]json.RawMessage, error) {
	_, err := a.loadState()
	if err != nil {
		return nil, err
	}
	c := a.config
	c.Restore = true
	reader := New(c)
	defer reader.Close()
	reader.collecting = true
	if err := reader.Start(ctx); err != nil {
		return nil, err
	}
	reader.mu.Lock()
	defer reader.mu.Unlock()
	if reader.historyOverflow {
		return nil, agent.ErrHistoryUnread
	}
	return reader.history, nil
}

func (a *Adapter) ReadHistory(ctx context.Context, cursor string) (agent.HistoryPage, error) {
	offset := 0
	if cursor != "" {
		n, err := strconv.Atoi(cursor)
		if err != nil || n < 0 {
			return agent.HistoryPage{}, agent.ErrInvalidCursor
		}
		offset = n
	}
	entries, err := a.nativeHistory(ctx)
	if err != nil {
		return agent.HistoryPage{}, err
	}
	if offset > len(entries) {
		return agent.HistoryPage{}, agent.ErrHistoryChanged
	}
	end := min(offset+16, len(entries))
	next := ""
	if end < len(entries) {
		next = strconv.Itoa(end)
	}
	raw, _ := json.Marshal(entries[offset:end])
	return agent.HistoryPage{Data: raw, NextCursor: next}, nil
}

func (a *Adapter) ReadBrowserHistory(ctx context.Context, cursor string, limit int) (protocol.SessionHistoryPage, error) {
	s, err := a.loadState()
	if err != nil {
		return protocol.SessionHistoryPage{}, err
	}
	pager, err := agent.NewHistoryPager("kiro:"+s.NativeID, cursor, limit)
	if err != nil {
		return protocol.SessionHistoryPage{}, err
	}
	entries, err := a.nativeHistory(ctx)
	if err != nil {
		return protocol.SessionHistoryPage{}, err
	}
	for i, raw := range entries {
		more, err := pager.Add(raw, sha256.Sum256(raw), int64(len(raw)), fmt.Sprintf("kiro:%s:%d", s.NativeID, i))
		if err != nil {
			return protocol.SessionHistoryPage{}, err
		}
		if !more {
			break
		}
	}
	return pager.Finish("")
}

func exactDelivery(text, id string) bool {
	for _, line := range strings.Split(text, "\n") {
		var e struct {
			ID string `json:"delivery_id"`
		}
		if json.Unmarshal([]byte(line), &e) == nil && e.ID == id {
			return true
		}
	}
	return false
}

func (a *Adapter) HistoryContains(id string, queried bool) (bool, error) {
	if id == "" {
		return false, nil
	}
	if queried {
		return a.queriedDelivery(id)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	entries, err := a.nativeHistory(ctx)
	if err != nil {
		return false, err
	}
	return containsHistory(entries, id, queried)
}

func containsHistory(entries []json.RawMessage, id string, queried bool) (bool, error) {
	tools := map[string]bool{}
	for _, raw := range entries {
		var p struct {
			Update struct {
				Kind      string          `json:"sessionUpdate"`
				ID        string          `json:"toolCallId"`
				ToolKind  string          `json:"kind"`
				Status    string          `json:"status"`
				Content   json.RawMessage `json:"content"`
				RawOutput json.RawMessage `json:"rawOutput"`
			} `json:"update"`
		}
		if json.Unmarshal(raw, &p) != nil {
			return false, ErrIncompatible
		}
		u := p.Update
		if u.Kind == "tool_call" {
			tools[u.ID] = u.ToolKind == "execute"
		}
		if !queried && u.Kind == "user_message_chunk" {
			var c struct{ Type, Text string }
			if json.Unmarshal(u.Content, &c) == nil && c.Type == "text" && exactDelivery(c.Text, id) {
				return true, nil
			}
		}
		if queried && u.Kind == "tool_call_update" && u.Status == "completed" && tools[u.ID] {
			// completed 只说明工具调用结束；shell exitCode=0 才提供成功查询证据。
			raw := u.RawOutput
			var text string
			if json.Unmarshal(raw, &text) == nil {
				raw = json.RawMessage(text)
			}
			if output, ok := successfulShellOutput(raw); ok && exactDelivery(output, id) {
				return true, nil
			}

		}

	}
	return false, nil
}

func (a *Adapter) DeliverResult(ctx context.Context, id, payload string) (agent.Output, error) {
	var envelope struct {
		ID string `json:"delivery_id"`
	}
	if id == "" || len(payload) > task.ExecutorInputLimit || json.Unmarshal([]byte(payload), &envelope) != nil || envelope.ID != id {
		return agent.Output{}, ErrUncertain
	}
	a.mu.Lock()
	active := a.active
	a.mu.Unlock()
	if active {
		return agent.Output{}, ErrBusy
	}
	if found, err := a.HistoryContains(id, false); err != nil || found {
		return agent.Output{}, err
	}
	return agent.Output{}, a.prompt(ctx, id, payload)
}

// CLI 的 result 响应必须先返回，成功 shell 输出才会写入原生历史。
// 观察到匹配工具输出后异步核查持久历史，避免在 CLI 尚未得到响应时等待它的输出。
func (a *Adapter) queriedDelivery(id string) (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.queryIDs[id] && len(a.queryIDs) >= 128 {
		for previous := range a.queryConfirmed {
			delete(a.queryIDs, previous)
			delete(a.queryObserved, previous)
			delete(a.queryConfirmed, previous)
		}
		if len(a.queryIDs) >= 128 {
			return false, agent.ErrHistoryUnread
		}
	}
	a.queryIDs[id] = true
	if a.queryConfirmed[id] {
		a.queryObserved[id] = true
		if a.queuedFinal != nil && a.queriesObservedLocked() {
			a.emitLocked(*a.queuedFinal)
			a.queuedFinal = nil
		}
		return true, nil
	}
	hint, err := containsHistory(a.history, id, true)
	if err != nil {
		return false, err
	}
	if !hint || a.closed || a.queryChecking || time.Since(a.queryLast) < time.Second {
		return false, nil
	}
	a.queryChecking = true
	a.queryLast = time.Now()
	a.queryDone = make(chan struct{})
	done := a.queryDone
	a.queryWG.Add(1)
	go func() {
		defer a.queryWG.Done()
		defer close(done)
		ctx, cancel := context.WithTimeout(a.queryCtx, 10*time.Second)
		defer cancel()
		a.checkQueries(ctx)
		a.mu.Lock()
		a.queryChecking = false
		a.mu.Unlock()
	}()
	return false, nil
}

func (a *Adapter) checkQueries(ctx context.Context) {
	entries, err := a.nativeHistory(ctx)
	if err != nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for id := range a.queryIDs {
		if found, err := containsHistory(entries, id, true); err == nil && found {
			a.queryConfirmed[id] = true
		}
	}
}

// 最终 prompt 已响应后，尚未确认的工具查询先完成持久核对再发布结算。
func (a *Adapter) confirmQueries() bool {
	ctx, cancel := context.WithTimeout(a.queryCtx, 10*time.Second)
	defer cancel()
	a.mu.Lock()
	pending := false
	for id := range a.queryIDs {
		pending = pending || !a.queryConfirmed[id]
	}
	done := a.queryDone
	checking := a.queryChecking
	a.mu.Unlock()
	if !pending {
		return true
	}
	if checking {
		select {
		case <-done:
		case <-ctx.Done():
			return false
		}
	}
	a.mu.Lock()
	pending = false
	for id := range a.queryIDs {
		pending = pending || !a.queryConfirmed[id]
	}
	a.mu.Unlock()
	if pending {
		a.checkQueries(ctx)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for id := range a.queryIDs {
		if !a.queryConfirmed[id] {
			return false
		}
	}
	return true
}

func successfulShellOutput(raw json.RawMessage) (string, bool) {
	var result struct {
		Output   string `json:"output"`
		ExitCode *int   `json:"exitCode"`
	}
	if json.Unmarshal(raw, &result) == nil && result.ExitCode != nil {
		return result.Output, *result.ExitCode == 0
	}
	// Kiro session/load 将原生 shell 结果回放为带固定首尾标记的字符串。
	text, ok := strings.CutPrefix(string(raw), "Output:\n")
	if !ok {
		return "", false
	}
	at := strings.LastIndex(text, "\nExit Code: ")
	if at < 0 {
		return "", false
	}
	code, err := strconv.Atoi(strings.TrimSpace(text[at+len("\nExit Code: "):]))
	return strings.TrimSuffix(text[:at], "\n"), err == nil && code == 0
}

// Worker 已拿到每项 true 后，再发布对应终态，避免同一轮先查 false 后取终态的竞态。
func (a *Adapter) queriesObservedLocked() bool {
	for id := range a.queryIDs {
		if !a.queryObserved[id] {
			return false
		}
	}
	return true
}
