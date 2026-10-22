package kiro

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strconv"

	"baton/internal/agent"
	"baton/internal/protocol"
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
