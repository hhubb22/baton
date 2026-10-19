package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"strconv"
	"strings"
	"unicode/utf8"

	"baton/internal/protocol"
)

var (
	ErrInvalidCursor  = errors.New("历史游标无效")
	ErrHistoryChanged = errors.New("已读取的历史发生变化")
	ErrHistoryUnread  = errors.New("暂时无法读取本地历史")
)

type BrowserHistoryAdapter interface {
	ReadBrowserHistory(context.Context, string, int) (protocol.SessionHistoryPage, error)
}

// HistoryPager 用已读前缀摘要检测删除、重排与改写，内存只保留当前页。
type HistoryPager struct {
	page                protocol.SessionHistoryPage
	count, start, limit int
	expected            string
	sum                 hash.Hash
	checked             bool
}

func NewHistoryPager(binding, cursor string, limit int) (*HistoryPager, error) {
	if limit == 0 {
		limit = protocol.SessionHistoryItems
	}
	if limit < 1 || limit > protocol.SessionHistoryItems || len(cursor) > protocol.SessionCursorBytes {
		return nil, ErrInvalidCursor
	}
	p := &HistoryPager{limit: limit, sum: sha256.New(), page: protocol.SessionHistoryPage{Entries: []protocol.HistoryEntry{}}}
	p.sum.Write([]byte(binding))
	if cursor != "" {
		parts := strings.Split(cursor, ":")
		if len(parts) != 2 {
			return nil, ErrInvalidCursor
		}
		n, err := strconv.Atoi(parts[0])
		digest, digestErr := hex.DecodeString(parts[1])
		if err != nil || n < 0 || digestErr != nil || len(digest) != sha256.Size {
			return nil, ErrInvalidCursor
		}
		p.start, p.expected = n, parts[1]
	}
	p.page.Cursor = p.cursor()
	return p, nil
}

func (p *HistoryPager) cursor() string { return fmt.Sprintf("%d:%x", p.count, p.sum.Sum(nil)) }

func (p *HistoryPager) check() error {
	if p.count == p.start && !p.checked {
		if p.expected != "" && p.expected != hex.EncodeToString(p.sum.Sum(nil)) {
			return ErrHistoryChanged
		}
		p.checked = true
		p.page.Cursor = p.cursor()
	}
	return nil
}

// Add 的 digest 来自完整原生条目，raw 可以是超大条目的受限前缀。
// 返回 false 表示当前页已经装满，调用方停止读取后续历史。
func (p *HistoryPager) Add(raw []byte, digest [32]byte, size int64, reference string) (bool, error) {
	if err := p.check(); err != nil {
		return false, err
	}
	if p.count < p.start {
		p.sum.Write(digest[:])
		p.count++
		return true, nil
	}
	entry := protocol.HistoryEntry{Reference: textPrefix(PlainText(reference), 256), Bytes: size, Truncated: int64(len(raw)) < size || len(raw) > 8192}
	if len(raw) > 8192 {
		raw = raw[:8192]
	}
	entry.Text = PlainText(string(raw))
	var metadata struct{ ID, ParentID, Type string }
	if json.Unmarshal(raw, &metadata) == nil {
		entry.ID, entry.ParentID, entry.Kind = historyField(metadata.ID), historyField(metadata.ParentID), historyField(metadata.Type)
		entry.Truncated = entry.Truncated || entry.ID != metadata.ID || entry.ParentID != metadata.ParentID || entry.Kind != metadata.Type
	}
	// JSON 转义后仍限制单条大小，保证超大条目之后的记录可以继续分页。
	for {
		encoded, _ := json.Marshal(entry)
		if len(encoded) <= 4096 {
			break
		}
		entry.Truncated = true
		if entry.Text == "" {
			return false, ErrHistoryUnread
		}
		entry.Text = textPrefix(entry.Text, len(entry.Text)/2)
	}
	trial := p.page
	trial.Entries = append(append([]protocol.HistoryEntry(nil), p.page.Entries...), entry)
	trial.Gap = trial.Gap || entry.Truncated
	// 给游标增长和缺口原因预留空间。
	encoded, _ := json.Marshal(trial)
	if len(p.page.Entries) >= p.limit || len(encoded) > protocol.SessionHistoryBytes-256 {
		p.page.HasMore = true
		return false, nil
	}
	p.sum.Write(digest[:])
	p.count++
	p.page.Entries, p.page.Gap, p.page.Cursor = trial.Entries, trial.Gap, p.cursor()
	return true, nil
}

func (p *HistoryPager) Finish(code string) (protocol.SessionHistoryPage, error) {
	if err := p.check(); err != nil {
		return protocol.SessionHistoryPage{}, err
	}
	if !p.checked {
		return protocol.SessionHistoryPage{}, ErrHistoryChanged
	}
	if code != "" {
		p.page.Gap, p.page.Code = true, code
	}
	return p.page, nil
}

func historyField(s string) string { return textPrefix(PlainText(s), 64) }
func textPrefix(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
