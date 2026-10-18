// Package plane isolates the Plane Community 1.4.2 webhook and API contract.
package plane

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"regexp"
	"strings"

	"baton/internal/identity"
	"baton/internal/task"
)

const Path = "/hooks/plane"

type Actor struct {
	UserID     string     `json:"plane_user_id"`
	Email      string     `json:"email"`
	EmployeeID string     `json:"employee_id"`
	Task       task.Input `json:"task"`
}

type Config struct {
	URL             string  `json:"-"`
	APIKey          string  `json:"-"`
	Secret          string  `json:"-"`
	WorkspaceID     string  `json:"workspace_id"`
	WorkspaceSlug   string  `json:"workspace_slug"`
	ProjectID       string  `json:"project_id"`
	WebhookID       string  `json:"webhook_id"`
	ApprovalLabelID string  `json:"approval_label_id"`
	Actors          []Actor `json:"actors"`
}

// Load is opt-in. Credentials are never accepted inside the JSON configuration.
func Load(getenv func(string) string) (*Config, error) {
	raw := getenv("BATON_PLANE_CONFIG")
	if raw == "" {
		if getenv("BATON_PLANE_URL") != "" || getenv("BATON_PLANE_API_KEY") != "" || getenv("BATON_PLANE_WEBHOOK_SECRET") != "" {
			return nil, errors.New("需要设置 BATON_PLANE_CONFIG")
		}
		return nil, nil
	}
	var cfg Config
	if err := decodeStrict([]byte(raw), &cfg); err != nil {
		return nil, errors.New("BATON_PLANE_CONFIG 无效")
	}
	cfg.URL = getenv("BATON_PLANE_URL")
	cfg.APIKey = getenv("BATON_PLANE_API_KEY")
	cfg.Secret = getenv("BATON_PLANE_WEBHOOK_SECRET")
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c Config) validate() error {
	u, err := url.Parse(c.URL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("BATON_PLANE_URL 需要是 Plane 实例 Origin")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "https" && !(u.Scheme == "http" && ip != nil && ip.IsLoopback()) {
		return errors.New("BATON_PLANE_URL 需要 HTTPS")
	}
	if strings.TrimSpace(c.APIKey) == "" || strings.TrimSpace(c.Secret) == "" {
		return errors.New("Plane API key 和 Webhook secret 不能为空")
	}
	for _, id := range []string{c.WorkspaceID, c.ProjectID, c.WebhookID} {
		if canonical, err := identity.ParseUUID(id); err != nil || canonical != id {
			return errors.New("Plane 配置的 UUID 无效")
		}
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9_-]+$`).MatchString(c.WorkspaceSlug) {
		return errors.New("Plane workspace slug 无效")
	}
	if c.ApprovalLabelID != "" {
		if _, err := identity.ParseUUID(c.ApprovalLabelID); err != nil {
			return errors.New("Plane approval_label_id 无效")
		}
	}
	seen := map[string]bool{}
	for _, actor := range c.Actors {
		id, err := identity.ParseUUID(actor.UserID)
		if err != nil || id != actor.UserID || seen[id] || strings.TrimSpace(actor.Email) == "" {
			return errors.New("Plane 员工映射无效或重复")
		}
		seen[id] = true
		if _, err := identity.ParseUUID(actor.EmployeeID); err != nil {
			return errors.New("Baton 员工映射无效")
		}
		if actor.Task.RequestID != "" || actor.Task.Description != "" || actor.Task.SourceSessionID != nil || actor.Task.ParentTaskID != nil {
			return errors.New("Plane task 配置不能覆盖请求标识、说明或来源")
		}
	}
	return nil
}

func decodeStrict(raw []byte, dst any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("expected one JSON object")
	}
	return nil
}
