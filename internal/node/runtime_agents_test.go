package node

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
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
		if !caps.Queue || !caps.Stop || caps.Steer != (r.AgentType == "pi" || r.AgentType == "codex") || caps.Resume != (r.AgentType != "shell") || caps.SwitchModel != (r.AgentType == "pi" || r.AgentType == "codex") {
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

func TestRuntimeModelCache(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "failure"}[fail], func(t *testing.T) {
			calls := 0
			cache := runtimeModelCache{discover: func(ctx context.Context, name, path string) ([]protocol.RuntimeModel, string, error) {
				calls++
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("模型探测缺少期限")
				}
				if fail {
					return []protocol.RuntimeModel{{ID: "partial", Name: "Partial"}}, "partial", errors.New("private diagnostic")
				}
				return []protocol.RuntimeModel{{ID: name + "/model", Name: "Model"}}, name + "/model", nil
			}}
			check := func(name, path, version string, wantCalls int) {
				t.Helper()
				models, defaultModel := cache.models(t.Context(), name, path, version)
				if calls != wantCalls {
					t.Fatalf("探测次数：%d，预期 %d", calls, wantCalls)
				}
				if fail {
					if models == nil || len(models) != 0 || defaultModel != "" {
						t.Fatalf("失败结果未清空：%+v %q", models, defaultModel)
					}
				} else {
					if len(models) != 1 || models[0].ID != name+"/model" || defaultModel != name+"/model" {
						t.Fatalf("模型缓存错误：%+v %q", models, defaultModel)
					}
					models[0].ID = "mutated"
				}
			}
			check("pi", "/bin/pi", "1.0.0", 1)
			check("pi", "/bin/pi", "1.0.0", 1)
			check("pi", "/bin/pi", "1.1.0", 2)
			check("pi", "/other/pi", "1.1.0", 3)
			check("codex", "/bin/codex", "1.1.0", 4)
			check("pi", "/other/pi", "1.1.0", 4)
		})
	}
}

func TestRuntimeModelCacheRejectsInvalidDiscovery(t *testing.T) {
	for _, models := range [][]protocol.RuntimeModel{
		{{ID: "bad\nmodel", Name: "Model"}},
		{{ID: "model", Name: "Model"}, {ID: "model", Name: "Duplicate"}},
	} {
		calls := 0
		cache := runtimeModelCache{discover: func(context.Context, string, string) ([]protocol.RuntimeModel, string, error) {
			calls++
			return models, "model", nil
		}}
		for range 2 {
			got, defaultModel := cache.models(t.Context(), "pi", "/bin/pi", "1.0.0")
			if len(got) != 0 || defaultModel != "" || calls != 1 {
				t.Fatalf("无效模型缓存错误：%+v %q calls=%d", got, defaultModel, calls)
			}
		}
	}
}

func TestAgentModelsPersistAcrossReportCollection(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	calls := map[string]int{}
	version := "1.0.0"
	available := true
	cache := &runtimeModelCache{discover: func(_ context.Context, name, path string) ([]protocol.RuntimeModel, string, error) {
		calls[name]++
		return []protocol.RuntimeModel{{ID: name + "/model", Name: "Model"}}, name + "/model", nil
	}}
	probe := agentRuntimeProbe{
		lookup: func(name string) (string, error) {
			if !available {
				return "", exec.ErrNotFound
			}
			return "/bin/" + name, nil
		},
		version:  func(context.Context, string) (string, error) { return version, nil },
		verified: func(string, string) bool { return true },
		models:   cache.models,
	}
	dir := t.TempDir()
	collect := func() protocol.RuntimeReport {
		t.Helper()
		report, details := collectRuntimeReportUsingProbe(t.Context(), dir, probe)
		raw, err := runtimeReportWireJSON(report, &details)
		if err != nil {
			t.Fatal(err)
		}
		var got protocol.RuntimeReport
		if err := protocol.DecodeRuntimeMessage(raw, &got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	for range 3 {
		report := collect()
		for _, a := range report.Agents {
			if a.AgentType == "shell" {
				if a.Models == nil || len(a.Models) != 0 || a.DefaultModel != "" || a.Capabilities.SwitchModel {
					t.Fatalf("shell 模型上报错误：%+v", a)
				}
				continue
			}
			if len(a.Models) != 1 || a.Models[0].ID != a.AgentType+"/model" || a.DefaultModel != a.AgentType+"/model" {
				t.Fatalf("模型字段没有进入报告：%+v", a)
			}
		}
	}
	if !reflect.DeepEqual(calls, map[string]int{"pi": 1, "codex": 1, "kiro": 1}) {
		t.Fatal("重复报告启动了 Agent", calls)
	}
	available = false
	for _, a := range collect().Agents {
		if len(a.Models) != 0 || a.DefaultModel != "" {
			t.Fatal("缺失 Agent 上报了过期模型", a)
		}
	}
	available = true
	collect()
	if calls["pi"] != 1 {
		t.Fatal("相同版本重复探测", calls)
	}
	version = "1.1.0"
	collect()
	if !reflect.DeepEqual(calls, map[string]int{"pi": 2, "codex": 2, "kiro": 2}) {
		t.Fatal("版本变化未刷新模型", calls)
	}
}

func TestRuntimeReportBoundsLargeModelLists(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	calls := 0
	cache := &runtimeModelCache{discover: func(_ context.Context, name, path string) ([]protocol.RuntimeModel, string, error) {
		calls++
		models := make([]protocol.RuntimeModel, 50)
		for i := range models {
			models[i] = protocol.RuntimeModel{ID: strings.Repeat(string(rune('A'+i)), 512), Name: strings.Repeat("M", 512)}
		}
		return models, models[0].ID, nil
	}}
	probe := agentRuntimeProbe{
		lookup:   func(name string) (string, error) { return "/bin/" + name, nil },
		version:  func(context.Context, string) (string, error) { return "1.0.0", nil },
		verified: func(string, string) bool { return true },
		models:   cache.models,
	}
	dir, root := t.TempDir(), t.TempDir()
	if err := AddBrowseRoot(dir, "work", root); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		report, details := collectRuntimeReportUsingProbe(t.Context(), dir, probe)
		raw, err := runtimeReportWireJSON(report, &details)
		if err != nil || len(raw) > protocol.MaxRuntimeReportBytes || !report.Truncated {
			t.Fatalf("超大模型报告未截断：bytes=%d truncated=%v err=%v", len(raw), report.Truncated, err)
		}
		if len(report.Roots) != 1 || report.Roots[0].RootID != "work" {
			t.Fatalf("模型合计超限丢失了授权目录：%+v", report.Roots)
		}
		modelCount := 0
		for _, a := range report.Agents {
			modelCount += len(a.Models)
		}
		if modelCount == 0 || modelCount >= 150 {
			t.Fatalf("合计超限没有按容量保留模型：%d", modelCount)
		}
		for _, entry := range cache.entries {
			if len(entry.models) != 50 {
				t.Fatal("报告截断修改了模型缓存")
			}
		}
	}
	if calls != 3 {
		t.Fatal("超大报告重复探测模型", calls)
	}
}

func TestRuntimeWireReasonsMatchModelSnapshot(t *testing.T) {
	base := protocol.RuntimeAgent{
		AgentType: "pi", Version: "1.0.0", Status: "unverified",
		Models: []protocol.RuntimeModel{{ID: "pi/old", Name: "Old"}}, DefaultModel: "pi/old",
	}
	details := []agentRuntimeReport{{RuntimeAgent: base, Reason: "旧快照诊断"}}
	report := protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}, Agents: []protocol.RuntimeAgent{base}}
	for _, matching := range []bool{true, false} {
		if !matching {
			report.Agents[0].Models = []protocol.RuntimeModel{{ID: "pi/new", Name: "New"}}
		}
		raw, err := runtimeReportWireJSON(report, &details)
		if err != nil {
			t.Fatal(err)
		}
		var wire struct {
			Agents []agentRuntimeReport `json:"agents"`
		}
		if json.Unmarshal(raw, &wire) != nil || len(wire.Agents) != 1 {
			t.Fatalf("无效报告：%s", raw)
		}
		if (wire.Agents[0].Reason != "") != matching {
			t.Fatalf("模型快照混入旧诊断：%s", raw)
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
