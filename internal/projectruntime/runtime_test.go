package projectruntime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDecodeProbe(t *testing.T) {
	for _, test := range []struct {
		name string
		raw  string
		ok   bool
	}{
		{"sorted", `{"version":"0.1.0","providers":[{"provider":"xai","status":"login_required"},{"provider":"openai-codex","status":"available"}]}`, true},
		{"unknown_fields", `{"version":"0.1.0","providers":[],"future":true}`, true},
		{"unknown_status", `{"version":"0.1.0","providers":[{"provider":"xai","status":"bad"}]}`, false},
		{"duplicate", `{"version":"0.1.0","providers":[{"provider":"xai","status":"unknown"},{"provider":"xai","status":"available"}]}`, false},
		{"missing_version", `{"providers":[]}`, false},
		{"wrong_version", `{"version":"9.0.0","providers":[]}`, false},
		{"trailing_json", `{"version":"0.1.0","providers":[]} {}`, false},
		{"invalid_utf8", "\xff", false},
		{"invalid_json", "private-diagnostic", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			report, err := decodeProbe([]byte(test.raw))
			if (err == nil) != test.ok {
				t.Fatalf("报告校验错误: report=%+v err=%v", report, err)
			}
			if err != nil && strings.Contains(err.Error(), test.raw) {
				t.Fatal("原始诊断输出进入错误信息")
			}
			if test.name == "sorted" && report.Providers[0].Provider != "openai-codex" {
				t.Fatal("provider 排序不稳定")
			}
		})
	}
}

func TestCommandUsesRuntimeEnvironment(t *testing.T) {
	dir := t.TempDir()
	name := "baton-project-runtime"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("BATON_PROJECT_RUNTIME_DATA_DIR", filepath.Join(dir, "credentials"))
	t.Setenv("BATON_SIDECAR_HOST", "untrusted-host")
	cmd, err := Command(t.Context(), "login", "openai-codex")
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Path != path || strings.Join(cmd.Args[1:], " ") != "login openai-codex" || cmd.Cancel == nil {
		t.Fatalf("命令定位、参数或取消支持错误: %+v", cmd)
	}
	host, _ := os.Executable()
	env := map[string]string{}
	for _, entry := range cmd.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			env[key] = value
		}
	}
	if env["BATON_PROJECT_RUNTIME_DATA_DIR"] != filepath.Join(dir, "credentials") || env["BATON_SIDECAR_HOST"] != host {
		t.Fatal("Runtime 专用凭据目录或原生宿主设置错误")
	}
}

func TestMissingRuntimeReturnsInstallGuidance(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	_, err := Probe(context.Background())
	if err == nil || !strings.Contains(err.Error(), "完整安装包") {
		t.Fatalf("缺少安装指引: %v", err)
	}
}

func TestDecodeProbeRejectsInvalidModels(t *testing.T) {
	report := map[string]any{
		"version": Version,
		"providers": []any{map[string]any{
			"provider": "openai-codex", "status": "available",
			"models": []any{map[string]any{"id": "model"}},
		}},
	}
	raw, _ := json.Marshal(report)
	if _, err := decodeProbe(raw); err == nil {
		t.Fatal("接受缺少名称的模型")
	}
}
