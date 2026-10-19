package projectagent

import "time"

// Preview 是尚未保存的模型文本，正式事件保存后由序号使其失效。
type Preview struct {
	AfterSeq  int64     `json:"after_seq"`
	Text      string    `json:"text"`
	Truncated bool      `json:"truncated"`
	UpdatedAt time.Time `json:"updated_at"`
}
