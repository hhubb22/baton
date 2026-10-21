// Package inbox 定义事项及其事务内的状态变化。
package inbox

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"baton/internal/identity"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

var ErrInvalid = errors.New("事项参数无效")
var ErrNotFound = errors.New("事项不存在")
var ErrLimit = errors.New("本 Project 已有 10 个待处理提案，请先撤回或等待处理")

type Conflict struct{ Current Request }

func (c *Conflict) Error() string { return "事项已变化，请查看当前事项" }

type Option struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Recommended bool   `json:"recommended,omitempty"`
}
type Ask struct {
	Title     string   `json:"title"`
	Content   string   `json:"content"`
	Options   []Option `json:"options"`
	AllowText bool     `json:"allow_text"`
	ThreadID  string   `json:"thread_id,omitempty"`
}
type Resolution struct {
	ClientRequestID string `json:"client_request_id"`
	EmployeeID      string `json:"employee_id"`
	OptionID        string `json:"option_id,omitempty"`
	OptionLabel     string `json:"option_label,omitempty"`
	Text            string `json:"text,omitempty"`
}
type Request struct {
	ID                string `json:"id"`
	EmployeeID        string `json:"-"`
	ProjectID         string `json:"project_id"`
	ProjectTitle      string `json:"project_title"`
	OriginToolCallID  string `json:"origin_tool_call_id,omitempty"`
	AgentID           string `json:"-"`
	ConversationID    string `json:"conversation_id"`
	Source            string `json:"source"`
	ConditionType     string `json:"condition_type,omitempty"`
	ConditionObjectID string `json:"condition_object_id,omitempty"`
	Ask
	ActionURL      string      `json:"action_url,omitempty"`
	State          string      `json:"state"`
	Version        int         `json:"version"`
	Resolution     *Resolution `json:"resolution,omitempty"`
	ResolvedAt     *time.Time  `json:"resolved_at,omitempty"`
	WithdrawReason string      `json:"withdraw_reason,omitempty"`
	CreatedAt      time.Time   `json:"created_at"`
	UpdatedAt      time.Time   `json:"updated_at"`
}
type Handle struct {
	ExpectedVersion int    `json:"expected_version"`
	ClientRequestID string `json:"client_request_id"`
	OptionID        string `json:"option_id,omitempty"`
	Text            string `json:"text,omitempty"`
}

func (h Handle) Validate(close bool) error {
	if h.ExpectedVersion < 1 || !validText(h.ClientRequestID, 1, 128) || len(h.Text) > 4<<10 || !utf8.ValidString(h.Text) || strings.ContainsRune(h.Text, 0) {
		return ErrInvalid
	}
	if close && (h.OptionID != "" || h.Text != "") {
		return ErrInvalid
	}
	return nil
}

var optionID = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

func validText(s string, min, max int) bool {
	return utf8.ValidString(s) && !strings.ContainsRune(s, 0) && utf8.RuneCountInString(s) >= min && utf8.RuneCountInString(s) <= max && (min == 0 || strings.TrimSpace(s) != "")
}
func (a Ask) Validate() error {
	if !validText(a.Title, 1, 120) || len(a.Options) > 5 || (len(a.Options) == 0 && !a.AllowText) {
		return ErrInvalid
	}
	if a.ThreadID != "" {
		if _, err := identity.ParseUUID(a.ThreadID); err != nil {
			return ErrInvalid
		}
	}
	seen := map[string]bool{}
	recommended := 0
	for _, o := range a.Options {
		if !optionID.MatchString(o.ID) || seen[o.ID] || !validText(o.Label, 1, 40) || !validText(o.Description, 0, utf8.RuneCountInString(o.Description)) {
			return ErrInvalid
		}
		seen[o.ID] = true
		if o.Recommended {
			recommended++
		}
	}
	if recommended > 1 {
		return ErrInvalid
	}
	return ValidateContent(a.Content)
}

// ValidateContent 只检查 Markdown 字节上限和实际链接目标的协议。
func ValidateContent(content string) error {
	if len(content) > 32<<10 || !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return ErrInvalid
	}
	source := []byte(content)
	doc := goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser().Parse(text.NewReader(source))
	return ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		var dest []byte
		switch v := n.(type) {
		case *ast.Link:
			dest = v.Destination
		case *ast.AutoLink:
			dest = v.URL(source)
		default:
			return ast.WalkContinue, nil
		}
		dest = util.ResolveEntityNames(util.ResolveNumericReferences(util.UnescapePunctuations(dest)))
		u, err := url.Parse(string(dest))
		if err != nil || !strings.EqualFold(u.Scheme, "https") || u.Host == "" {
			return ast.WalkStop, ErrInvalid
		}
		return ast.WalkContinue, nil
	})
}
