package node

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRuntimeModelProbeUsesNativeCatalogAndDiscardsSession(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "model-probe")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", binary, "testdata/runtime_model_probe.go").CombinedOutput(); err != nil {
		t.Fatalf("构建模型探测程序失败：%v %s", err, out)
	}
	for _, name := range []string{"pi", "codex", "kiro"} {
		for _, mode := range []string{"success", "failure", "configured"} {
			t.Run(name+"/"+mode, func(t *testing.T) {
				testNativeRuntimeModelProbe(t, binary, name, mode)
			})
		}
	}
}

func testNativeRuntimeModelProbe(t *testing.T, binary, name, mode string) {
	t.Helper()
	fixtureDir := t.TempDir()
	fixture := filepath.Join(fixtureDir, filepath.Base(binary))
	if err := os.Link(binary, fixture); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(fixtureDir, "requests.jsonl")
	config, err := json.Marshal(map[string]any{"Agent": name, "Log": log, "Failure": mode == "failure"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixtureDir, "config.json"), config, 0o600); err != nil {
		t.Fatal(err)
	}
	prefix := "BATON_" + strings.ToUpper(name)
	home, configuredModel := "", ""
	if mode == "configured" {
		home, configuredModel = t.TempDir(), "configured-model"
		if name == "pi" {
			configuredModel = "provider/" + configuredModel
		}
	}
	t.Setenv(prefix+"_HOME", home)
	t.Setenv(prefix+"_MODEL", configuredModel)
	binaryEnv := prefix + "_BINARY"
	if name == "pi" {
		binaryEnv = "BATON_PI_BIN"
	}
	t.Setenv(binaryEnv, fixture)
	path, err := threadAgentLookup(name)
	if err != nil || path != fixture {
		t.Fatalf("未采用 Worker 的 Agent 可执行文件：%q %v", path, err)
	}
	probe := defaultAgentProbe()
	for range 2 {
		models, defaultModel := probe.models(t.Context(), name, path, "1.0.0")
		if mode == "failure" {
			if models == nil || len(models) != 0 || defaultModel != "" {
				t.Fatalf("探测失败没有清空模型：%+v %q", models, defaultModel)
			}
			continue
		}
		id := "model-a"
		if name == "pi" {
			id = "provider/" + id
		}
		wantDefault := id
		if configuredModel != "" {
			wantDefault = configuredModel
		}
		if len(models) != 1 || models[0].ID != id || models[0].Name != "Model A" || defaultModel != wantDefault {
			t.Fatalf("原生模型没有进入缓存：%+v %q，预期默认模型 %q", models, defaultModel, wantDefault)
		}
	}
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	starts, catalogCalls := 0, 0
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var entry struct {
			Method, Cwd, Home string
			CodexHome         string `json:"codex_home"`
		}
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(entry.Cwd); !os.IsNotExist(err) {
			t.Fatalf("探测工作目录未丢弃：%s %v", entry.Cwd, err)
		}
		if home != "" {
			gotHome := entry.Home
			if name == "codex" {
				gotHome = entry.CodexHome
			}
			if gotHome != home {
				t.Fatalf("探测未采用 Worker 的 Agent HOME：%q，预期 %q", gotHome, home)
			}
		}
		switch entry.Method {
		case "start":
			starts++
		case "get_available_models", "model/list", "session/new":
			catalogCalls++
		case "initialize", "initialized", "set_auto_retry", "get_state":
		default:
			t.Fatalf("模型探测发送了非元数据请求：%s", entry.Method)
		}
	}
	if starts != 1 || catalogCalls != 1 {
		t.Fatalf("相同版本重复启动模型探测：starts=%d catalog=%d", starts, catalogCalls)
	}
}
