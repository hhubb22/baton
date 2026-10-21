package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	BodyRuntimeReport       = "node.runtime_report"
	BodyRuntimeReportResult = "node.runtime_report_result"
	MaxRuntimeReportBytes   = 64 << 10
)

type RuntimeReport struct {
	Agents         []RuntimeAgent  `json:"agents,omitempty"`
	ProjectRuntime *ProjectRuntime `json:"project_runtime,omitempty"`
	Exec           RuntimeExec     `json:"exec"`
	Roots          []RuntimeRoot   `json:"roots"`
	Repos          []RuntimeRepo   `json:"repos"`
	Truncated      bool            `json:"truncated,omitempty"`
}

type RuntimeAgent struct {
	AgentType    string             `json:"agent_type"`
	Version      string             `json:"version"`
	Status       string             `json:"status"`
	Capabilities ThreadCapabilities `json:"capabilities"`
}
type ThreadCapabilities struct {
	Create bool `json:"create"`
	Queue  bool `json:"queue"`
	Steer  bool `json:"steer"`
	Stop   bool `json:"stop"`
	Resume bool `json:"resume"`
}

type ProjectRuntime struct {
	Version   string            `json:"version"`
	Providers []RuntimeProvider `json:"providers"`
}
type RuntimeProvider struct {
	Provider string `json:"provider"`
	Status   string `json:"status"`
}
type RuntimeExec struct {
	Enabled bool   `json:"enabled"`
	Shell   string `json:"shell"`
}
type RuntimeRoot struct {
	RootID string `json:"root_id"`
	Path   string `json:"path"`
}
type RuntimeRepo struct {
	Path   string `json:"path"`
	Origin string `json:"origin,omitempty"`
}
type RuntimeReportRequest struct {
	Type   string        `json:"type"`
	Report RuntimeReport `json:"report"`
}
type RuntimeReportResult struct {
	Type          string `json:"type"`
	OK            bool   `json:"ok"`
	Code          string `json:"code,omitempty"`
	ReportVersion int64  `json:"report_version,omitempty"`
}

var runtimeName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$`)
var runtimeRootID = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)
var ErrRuntimeReport = errors.New("节点能力报告无效")

// DecodeRuntimeJSON 拒绝未约定字段和尾随数据，避免将凭据或诊断输出带入报告。
func DecodeRuntimeJSON(raw []byte, out any) error {
	if len(raw) > MaxRuntimeReportBytes || !utf8.Valid(raw) {
		return ErrRuntimeReport
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil || d.Decode(new(any)) != io.EOF {
		return ErrRuntimeReport
	}
	return nil
}

// DecodeRuntimeMessage 忽略跨进程报告的未知字段，保留大小、编码和单文档限制。
func DecodeRuntimeMessage(raw []byte, out any) error {
	if len(raw) > MaxRuntimeReportBytes || !utf8.Valid(raw) {
		return ErrRuntimeReport
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	if d.Decode(out) != nil || d.Decode(new(any)) != io.EOF {
		return ErrRuntimeReport
	}
	return nil
}

func ValidateProjectRuntime(p *ProjectRuntime) error {
	if p == nil {
		return nil
	}
	if !runtimeName.MatchString(p.Version) || len(p.Providers) > 32 {
		return ErrRuntimeReport
	}
	seen := map[string]bool{}
	for _, v := range p.Providers {
		if !runtimeName.MatchString(v.Provider) || seen[v.Provider] {
			return ErrRuntimeReport
		}
		if v.Status != "available" && v.Status != "login_required" && v.Status != "unknown" {
			return ErrRuntimeReport
		}
		seen[v.Provider] = true
	}
	return nil
}

func runtimeText(s string, max int) bool {
	return s != "" && len(s) <= max && utf8.ValidString(s) && !strings.ContainsFunc(s, unicode.IsControl)
}

// RuntimeReportJSON 使用比 PostgreSQL jsonb 文本更宽的排版计量，预留数据库规范化的空格。
func RuntimeReportJSON(r RuntimeReport) ([]byte, error) {
	if ValidateProjectRuntime(r.ProjectRuntime) != nil || !runtimeText(r.Exec.Shell, 4096) || len(r.Roots) > 32 || len(r.Repos) > 128 {
		return nil, ErrRuntimeReport
	}
	if len(r.Agents) > 32 {
		return nil, ErrRuntimeReport
	}
	agents := map[string]bool{}
	for _, a := range r.Agents {
		if !runtimeName.MatchString(a.AgentType) || !runtimeName.MatchString(a.Version) || agents[a.AgentType] || (a.Status != "available" && a.Status != "unverified" && a.Status != "unavailable") {
			return nil, ErrRuntimeReport
		}
		agents[a.AgentType] = true
	}
	seen := map[string]bool{}
	for _, root := range r.Roots {
		if !runtimeRootID.MatchString(root.RootID) || seen[root.RootID] || !runtimeText(root.Path, 4096) {
			return nil, ErrRuntimeReport
		}
		seen[root.RootID] = true
	}
	for _, repo := range r.Repos {
		if !runtimeText(repo.Path, 4096) || (repo.Origin != "" && SanitizeOrigin("ssh://"+repo.Origin) != repo.Origin) {
			return nil, ErrRuntimeReport
		}
	}
	wide, err := json.MarshalIndent(r, "", " ")
	if err != nil || len(wide) > MaxRuntimeReportBytes {
		return nil, ErrRuntimeReport
	}
	return json.Marshal(r)
}

// SanitizeOrigin 只保留远端主机和仓库路径；用户信息、查询、片段及本地地址不进入报告。
func SanitizeOrigin(raw string) string {
	if !runtimeText(raw, 4096) {
		return ""
	}
	var u *url.URL
	var err error
	if strings.Contains(raw, "://") {
		u, err = url.Parse(raw)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http" && u.Scheme != "ssh" && u.Scheme != "git") {
			return ""
		}
	} else {
		// Git 的 scp 地址只允许主机与路径之间出现一个冒号。
		if colon := strings.IndexByte(raw, ':'); colon >= 0 {
			if strings.Contains(raw[:colon], "/") || strings.Contains(raw[colon+1:], ":") || colon == 1 {
				return ""
			}
			raw = raw[:colon] + "/" + raw[colon+1:]
		} else {
			return ""
		}
		u, err = url.Parse("ssh://" + raw)
	}
	if err != nil || u.Hostname() == "" || !strings.Contains(u.Path, "/") || u.Path == "/" {
		return ""
	}
	if strings.ContainsAny(u.Host, "@\\ ") || strings.ContainsAny(u.Path, "@\\") {
		return ""
	}
	if strings.Contains(u.Hostname(), ":") {
		return ""
	}
	return u.Hostname() + u.EscapedPath()
}
