package node

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"baton/internal/agent"
	"baton/internal/agent/codex"
	"baton/internal/agent/kiro"
	"baton/internal/agent/pi"
	"baton/internal/agent/shell"
	"baton/internal/protocol"
	"baton/internal/sidecar"
)

// agentRuntimeReport 在节点报告中附带固定诊断，兼容尚未声明 reason 字段的中心。
type agentRuntimeReport struct {
	protocol.RuntimeAgent
	Reason string `json:"reason,omitempty"`
}

type agentRuntimeProbe struct {
	lookup   func(string) (string, error)
	version  func(context.Context, string) (string, error)
	verified func(string, string) bool
	models   func(context.Context, string, string, string) ([]protocol.RuntimeModel, string)
}

// RuntimeModelDiscovery 返回指定 Agent 及可执行文件的模型目录和默认模型。
// nil 使用原生 Agent 探测。
type RuntimeModelDiscovery func(context.Context, string, string) ([]protocol.RuntimeModel, string, error)

type cachedRuntimeModels struct {
	path, version string
	models        []protocol.RuntimeModel
	defaultModel  string
}

// runtimeModelCache 由单一采集者持有，成功和失败均缓存到可执行文件或版本变化。
type runtimeModelCache struct {
	discover RuntimeModelDiscovery
	entries  map[string]cachedRuntimeModels
}

func (c *runtimeModelCache) models(ctx context.Context, name, path, version string) ([]protocol.RuntimeModel, string) {
	if c.entries == nil {
		c.entries = make(map[string]cachedRuntimeModels)
	}
	entry, ok := c.entries[name]
	if !ok || entry.path != path || entry.version != version {
		entry = cachedRuntimeModels{path: path, version: version, models: []protocol.RuntimeModel{}}
		probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		models, defaultModel, err := c.discover(probeCtx, name, path)
		cancel()
		if err == nil && validRuntimeModels(models, defaultModel) {
			entry.models = append(entry.models, models...)
			entry.defaultModel = defaultModel
		}
		c.entries[name] = entry
	}
	return slices.Clone(entry.models), entry.defaultModel
}

func validModelText(value string) bool {
	return len(value) <= 512 && utf8.ValidString(value) && !strings.ContainsFunc(value, unicode.IsControl)
}

func validRuntimeModels(models []protocol.RuntimeModel, defaultModel string) bool {
	if !validModelText(defaultModel) {
		return false
	}
	seen := make(map[string]bool, len(models))
	for _, model := range models {
		if model.ID == "" || model.Name == "" || !validModelText(model.ID) || !validModelText(model.Name) || seen[model.ID] {
			return false
		}
		seen[model.ID] = true
	}
	return true
}

func discoverRuntimeModels(ctx context.Context, name, path string) ([]protocol.RuntimeModel, string, error) {
	dir, err := os.MkdirTemp("", "baton-model-probe-*")
	if err != nil {
		return nil, "", err
	}
	defer os.RemoveAll(dir)
	prefix := "BATON_" + strings.ToUpper(name)
	cfg := agent.Config{Binary: path, Directory: dir, Home: os.Getenv(prefix + "_HOME"), Model: os.Getenv(prefix + "_MODEL")}
	var result agent.ModelCatalog
	switch name {
	case "pi":
		result, err = pi.ProbeModels(ctx, cfg)
	case "codex":
		result, err = codex.ProbeModels(ctx, cfg)
	case "kiro":
		result, err = kiro.ProbeModels(ctx, cfg)
	default:
		return nil, "", errors.New("不支持此 Agent 的模型探测")
	}
	if err != nil {
		return nil, "", err
	}
	models := make([]protocol.RuntimeModel, 0, len(result.Models))
	for _, model := range result.Models {
		models = append(models, protocol.RuntimeModel{ID: model.ID, Name: model.Name})
	}
	return models, result.DefaultModel, nil
}

func runtimeAgentCapabilities(name string) agent.Capabilities {
	switch name {
	case "pi":
		return (&pi.Adapter{}).Capabilities()
	case "codex":
		return (&codex.Adapter{}).Capabilities()
	case "kiro":
		return (&kiro.Adapter{}).Capabilities()
	default:
		return (&shell.Adapter{}).Capabilities()
	}
}

func threadAgentBinary(name string) string {
	binaryEnv := "BATON_" + strings.ToUpper(name) + "_BINARY"
	if name == "pi" {
		binaryEnv = "BATON_PI_BIN"
	}
	if binary := os.Getenv(binaryEnv); binary != "" {
		return binary
	}
	if name == "kiro" {
		return "kiro-cli"
	}
	return name
}

func threadAgentLookup(agent string) (string, error) { return exec.LookPath(threadAgentBinary(agent)) }

var agentVersionPattern = regexp.MustCompile(`(?:^|[\s/])v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._+-]+)?)(?:$|\s)`)

func defaultAgentProbe() agentRuntimeProbe {
	return newAgentProbe(nil, nil)
}

func newAgentProbe(discover RuntimeModelDiscovery, version func(context.Context, string) (string, error)) agentRuntimeProbe {
	if discover == nil {
		discover = discoverRuntimeModels
	}
	cache := &runtimeModelCache{discover: discover}
	if version == nil {
		version = probeAgentVersion
	}
	return agentRuntimeProbe{lookup: exec.LookPath, models: cache.models, version: version,
		verified: supportsAgentVersion}
}

func supportsAgentVersion(name, version string) bool {
	switch name {
	case "pi":
		return pi.SupportsVersion(version)
	case "codex":
		return codex.SupportsVersion(version)
	case "kiro":
		return kiro.SupportsVersion(version)
	default:
		return false
	}
}

func probeAgentVersion(ctx context.Context, path string) (string, error) {
	bounded, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(bounded, path, "--version")
	raw, err := sidecar.Capture(bounded, cmd, 4096)
	if err != nil {
		return "", err
	}
	match := agentVersionPattern.FindStringSubmatch(strings.TrimSpace(string(raw)))
	if len(match) != 2 || len(match[1]) > 128 {
		return "", errors.New("无法识别版本")
	}
	return match[1], nil
}

func runtimeReportWireJSON(r protocol.RuntimeReport, agents *[]agentRuntimeReport) ([]byte, error) {
	raw, err := protocol.RuntimeReportJSON(r)
	if err != nil || agents == nil {
		return raw, err
	}
	// 只给本次快照中完全相同的能力附加诊断，避免采集切换时混用版本。
	wire := make([]agentRuntimeReport, 0, len(r.Agents))
	for _, base := range r.Agents {
		a := agentRuntimeReport{RuntimeAgent: base}
		for _, detail := range *agents {
			if detail.AgentType == base.AgentType && detail.Version == base.Version && detail.Status == base.Status && detail.DefaultModel == base.DefaultModel && detail.Capabilities == base.Capabilities && slices.Equal(detail.Models, base.Models) {
				a.Reason = detail.Reason
				break
			}
		}
		wire = append(wire, a)
	}
	value := struct {
		protocol.RuntimeReport
		Agents []agentRuntimeReport `json:"agents,omitempty"`
	}{r, wire}
	wide, err := json.MarshalIndent(value, "", " ")
	if err != nil || len(wide) > protocol.MaxRuntimeReportBytes {
		return nil, protocol.ErrRuntimeReport
	}
	return json.Marshal(value)
}

func collectAgentRuntimeReports(ctx context.Context, cfg protocol.RuntimeExec, probe agentRuntimeProbe) []agentRuntimeReport {
	reports := make([]agentRuntimeReport, 0, 4)
	for _, name := range []string{"pi", "codex", "kiro", "shell"} {
		native := runtimeAgentCapabilities(name)
		caps := protocol.ThreadCapabilities{Queue: true, Stop: true, Resume: native.Resume, Steer: native.Steer, SwitchModel: native.SwitchModel}
		report := agentRuntimeReport{RuntimeAgent: protocol.RuntimeAgent{AgentType: name, Version: "unknown", Status: "unavailable", Models: []protocol.RuntimeModel{}, Capabilities: caps}}
		binary := threadAgentBinary(name)
		if name == "shell" {
			report.Version = "builtin"
			binary = cfg.Shell
			if !cfg.Enabled {
				report.Reason = "本地 project-exec 未启用"
				reports = append(reports, report)
				continue
			}
		}
		path, err := probe.lookup(binary)
		if err != nil {
			report.Reason = "缺少可执行文件：" + binary
			reports = append(reports, report)
			continue
		}
		if name == "shell" {
			report.Status = "available"
			report.Capabilities.Create = true
		} else {
			version, err := probe.version(ctx, path)
			if err != nil {
				report.Status = "unverified"
				report.Reason = "无法确认 Agent 版本"
			} else {
				report.Version = version
				if probe.models != nil {
					report.Models, report.DefaultModel = probe.models(ctx, name, path, version)
				}
				if probe.verified != nil && probe.verified(name, version) {
					report.Status = "available"
					report.Capabilities.Create = true
				} else {
					report.Status = "unverified"
					report.Reason = "此 Agent 版本尚未验证"
				}
			}
		}
		reports = append(reports, report)
	}
	return reports
}
