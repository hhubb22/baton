package protocol

import "encoding/json"

const (
	SessionHistoryBytes = 14 * 1024
	SessionHistoryItems = 16
	SessionCursorBytes  = 100
)

// HistoryEntry 保留原生条目的关系；超大正文通过节点本地引用定位。
type HistoryEntry struct {
	ID        string `json:"id,omitempty"`
	ParentID  string `json:"parent_id,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Text      string `json:"text"`
	Reference string `json:"reference"`
	Bytes     int64  `json:"bytes"`
	Truncated bool   `json:"truncated"`
}

type SessionHistoryPage struct {
	Entries []HistoryEntry `json:"entries"`
	Cursor  string         `json:"cursor"`
	HasMore bool           `json:"has_more"`
	Gap     bool           `json:"gap"`
	Code    string         `json:"code,omitempty"`
}

// ValidHistoryPage 在临时通道边界检查序列化大小，避免节点扩大中心缓存。
func ValidHistoryPage(page *SessionHistoryPage) bool {
	if page == nil {
		return false
	}
	raw, err := json.Marshal(page)
	return err == nil && len(raw) <= SessionHistoryBytes && len(page.Entries) <= SessionHistoryItems && len(page.Cursor) <= SessionCursorBytes && len(page.Code) <= 64
}
