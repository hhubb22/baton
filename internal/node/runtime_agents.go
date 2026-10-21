package node

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"regexp"
	"strings"
	"time"

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
}

func threadAgentBinary(agent string) string {
	if agent == "kiro" {
		return "kiro-cli"
	}
	return agent
}

func threadAgentLookup(agent string) (string, error) { return exec.LookPath(threadAgentBinary(agent)) }

var agentVersionPattern = regexp.MustCompile(`(?:^|[\s/])v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._+-]+)?)(?:$|\s)`)

func defaultAgentProbe() agentRuntimeProbe {
	return agentRuntimeProbe{lookup: exec.LookPath, version: func(ctx context.Context, path string) (string, error) {
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
	}, verified: func(_ string, version string) bool { return version != "" && version != "unknown" }}
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
			if detail.RuntimeAgent == base {
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
		caps := protocol.ThreadCapabilities{Queue: true, Stop: true, Resume: name != "shell", Steer: name == "pi" || name == "codex"}
		report := agentRuntimeReport{RuntimeAgent: protocol.RuntimeAgent{AgentType: name, Version: "unknown", Status: "unavailable", Capabilities: caps}}
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
