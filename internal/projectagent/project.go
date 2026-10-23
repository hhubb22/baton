// Package projectagent 定义中心保存的 Project、主对话与项目记忆。
package projectagent

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const MaxMessageBytes = 64 << 10
const MaxContentBytes = 64 << 10
const MaxEventPageBytes = 192 << 10

var ErrInvalid = errors.New("Project 参数不正确")
var ErrTooLarge = errors.New("正文超过 64 KiB")
var ErrProjectConflict = errors.New("项目标识已用于不同内容")
var ErrMessageConflict = errors.New("消息标识已用于不同内容")

type MessageInput struct {
	ClientMessageID string `json:"client_message_id"`
	Content         string `json:"content"`
}

func (m MessageInput) Validate() error {
	if len(m.Content) > MaxMessageBytes {
		return ErrTooLarge
	}
	if !validText(m.Content) || strings.TrimSpace(m.Content) == "" ||
		len(m.ClientMessageID) < 1 || len(m.ClientMessageID) > 128 ||
		strings.ContainsFunc(m.ClientMessageID, func(r rune) bool { return r < 33 || r > 126 }) {
		return ErrInvalid
	}
	return nil
}

type Message struct {
	ID              int64     `json:"id"`
	ClientMessageID string    `json:"client_message_id"`
	Content         string    `json:"content"`
	CreatedAt       time.Time `json:"created_at"`
}

type Project struct {
	ID           string       `json:"id"`
	Title        string       `json:"title"`
	Goal         string       `json:"goal"`
	Status       string       `json:"status"`
	Version      int64        `json:"version"`
	CreatedAt    time.Time    `json:"created_at"`
	UpdatedAt    time.Time    `json:"updated_at"`
	Agent        Agent        `json:"agent"`
	Conversation Conversation `json:"conversation"`
}

type Agent struct {
	ID       string `json:"id"`
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

type Conversation struct {
	ID      string `json:"id"`
	State   string `json:"state"`
	LastSeq int64  `json:"last_seq"`
}

type CreateInput struct {
	ClientProjectID string `json:"client_project_id,omitempty"`
	Title           string `json:"title"`
	Goal            string `json:"goal"`
	Provider        string `json:"provider"`
	Model           string `json:"model"`
}

type Patch struct {
	Title    *string `json:"title"`
	Goal     *string `json:"goal"`
	Status   *string `json:"status"`
	Provider *string `json:"provider"`
	Model    *string `json:"model"`
}

func (p Project) Validate() error {
	if !ValidTitle(p.Title) || !validText(p.Goal) || len(p.Goal) > MaxContentBytes ||
		!validLabel(p.Agent.Provider) || !validLabel(p.Agent.Model) {
		return ErrInvalid
	}
	switch p.Status {
	case "active", "paused", "archived":
		return nil
	default:
		return ErrInvalid
	}
}

func ValidTitle(s string) bool {
	return strings.TrimSpace(s) != "" && utf8.RuneCountInString(s) <= 200 && validLabel(s)
}

func validLabel(s string) bool {
	return validText(s) && len(s) <= 1024 && !strings.ContainsFunc(s, unicode.IsControl)
}

func validText(s string) bool { return utf8.ValidString(s) && !strings.ContainsRune(s, 0) }

type Event struct {
	ConversationID string          `json:"conversation_id"`
	Seq            int64           `json:"seq"`
	Kind           string          `json:"kind"`
	ClientEventID  *string         `json:"client_event_id,omitempty"`
	ToolCallID     *string         `json:"tool_call_id,omitempty"`
	RunID          *string         `json:"run_id,omitempty"`
	LeaseEpoch     *int64          `json:"lease_epoch,omitempty"`
	Payload        json.RawMessage `json:"payload"`
	CreatedAt      time.Time       `json:"created_at"`
}

type EventPage struct {
	Events       []Event `json:"events"`
	LastSeq      int64   `json:"last_seq"`
	NextAfterSeq int64   `json:"next_after_seq"`
	HasMore      bool    `json:"has_more"`
}

type Memory struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	Revision  int64     `json:"revision"`
	Author    string    `json:"author"`
	SourceSeq *int64    `json:"source_seq"`
	UpdatedAt time.Time `json:"updated_at"`
}

type MemoryWrite struct {
	Title            string
	Content          string
	ExpectedRevision int64
	Author           string
	SourceSeq        *int64
}

func (m MemoryWrite) Validate() error {
	if !ValidTitle(m.Title) || !validText(m.Content) || m.ExpectedRevision < 0 ||
		(m.Author != "user" && m.Author != "agent") || (m.SourceSeq != nil && *m.SourceSeq <= 0) {
		return ErrInvalid
	}
	if len(m.Content) > MaxContentBytes {
		return ErrTooLarge
	}
	return nil
}

type MemoryConflict struct{ Current *Memory }

func (e *MemoryConflict) Error() string {
	return "记忆版本已变化，请读取当前版本后重试"
}
