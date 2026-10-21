package node

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"baton/internal/protocol"
)

func TestAgentCapabilityCollection(t *testing.T) {
	probe := agentRuntimeProbe{
		lookup:   func(name string) (string, error) { return "/bin/" + name, nil },
		version:  func(context.Context, string) (string, error) { return "1.2.3", nil },
		verified: func(agent, version string) bool { return agent != "kiro" && version == "1.2.3" },
	}
	reports := collectAgentRuntimeReports(t.Context(), protocol.RuntimeExec{Enabled: true, Shell: "sh"}, probe)
	if len(reports) != 4 {
		t.Fatal(reports)
	}
	for _, r := range reports {
		caps := r.Capabilities
		if !caps.Queue || !caps.Stop || caps.Steer != (r.AgentType == "pi" || r.AgentType == "codex") || caps.Resume != (r.AgentType != "shell") {
			t.Fatalf("能力错误：%+v", r)
		}
		if r.AgentType == "kiro" {
			if r.Status != "unverified" || r.Reason == "" || caps.Create {
				t.Fatal("未验证版本被公布为支持", r)
			}
		} else if r.Status != "available" || !caps.Create {
			t.Fatal("可用 Agent 未上报", r)
		}
	}
	probe.lookup = func(string) (string, error) { return "", exec.ErrNotFound }
	missing := collectAgentRuntimeReports(t.Context(), protocol.RuntimeExec{Enabled: true, Shell: "missing-shell"}, probe)
	for _, r := range missing {
		if r.Status != "unavailable" || r.Capabilities.Create || r.Reason == "" {
			t.Fatal("缺失二进制的报告错误", r)
		}
	}
	probe.lookup = func(name string) (string, error) { return name, nil }
	probe.version = func(context.Context, string) (string, error) { return "", errors.New("probe failed") }
	unknown := collectAgentRuntimeReports(t.Context(), protocol.RuntimeExec{Shell: "sh"}, probe)
	for _, r := range unknown {
		if r.AgentType == "shell" {
			if r.Status != "unavailable" || r.Reason != "本地 project-exec 未启用" {
				t.Fatal(r)
			}
		} else if r.Status != "unverified" || r.Version != "unknown" || r.Reason == "" {
			t.Fatal(r)
		}
	}
}

func TestAgentReasonsReachRuntimeWire(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	report, agents := collectRuntimeReportWithAgents(t.Context(), t.TempDir())
	if len(report.Agents) != 4 {
		t.Fatal("RuntimeReport.Agents 缺失", report)
	}
	raw, err := runtimeReportWireJSON(report, &agents)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Agents []struct {
			AgentType string `json:"agent_type"`
			Status    string `json:"status"`
			Reason    string `json:"reason"`
		} `json:"agents"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire.Agents) != 4 {
		t.Fatal(string(raw))
	}
	for _, a := range wire.Agents {
		if a.Reason == "" || a.Status != "unavailable" {
			t.Fatalf("缺项原因未进入发送正文：%s", raw)
		}
	}
	var decoded protocol.RuntimeReport
	if err := protocol.DecodeRuntimeMessage(raw, &decoded); err != nil {
		t.Fatal("扩展 reason 破坏协议兼容", err)
	}
	if len(decoded.Agents) != 4 {
		t.Fatal(decoded)
	}
}

func TestAgentVersionProbeIsBoundedAndDoesNotPublishDiagnostics(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("版本脚本测试使用 POSIX shell")
	}
	dir := t.TempDir()
	binary := filepath.Join(dir, "codex")
	for _, test := range []struct {
		body    string
		version string
		ok      bool
	}{
		{"printf 'codex-cli 1.2.3\\n'", "1.2.3", true},
		{"printf '0.60.0-beta.2\\n'", "0.60.0-beta.2", true},
		{"printf 'unknown secret diagnostic\\n'", "", false},
		{"exit 1", "", false},
		{"while :; do :; done", "", false},
		{"while :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done", "", false},
	} {
		if err := os.WriteFile(binary, []byte("#!/bin/sh\n"+test.body+"\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		version, err := defaultAgentProbe().version(t.Context(), binary)
		if (err == nil) != test.ok || version != test.version || time.Since(start) > 2*time.Second {
			t.Fatalf("版本探测：%q %v 耗时 %s", version, err, time.Since(start))
		}
	}
}
