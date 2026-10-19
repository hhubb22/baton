package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"

	"baton/internal/agent/replay"
)

// 测试子进程只回传夹具参数与指定环境，不调用任何 Agent 或模型。
func TestRealRecordingChild(t *testing.T) {
	if os.Getenv("BATON_RECORDING_CHILD") != "1" {
		t.Skip("录制夹具子进程")
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"args": os.Args[1:], "fixture_env": os.Getenv("BATON_RECORDING_VALUE")})
	fmt.Fprintln(os.Stderr, "recording fixture stderr")
	os.Exit(23)
}

func TestRealRecordingHarness(t *testing.T) {
	t.Setenv("BATON_RECORD_DIR", t.TempDir())
	tool := realRecordingTool(t)
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"simple", "restore_load_only"} {
		t.Run(scenario, func(t *testing.T) {
			work := t.TempDir()
			r := newRealRecording(t, tool, "codex", "fixture", "fixture-model", binary, map[string]string{"<workspace>": work})
			r.bind(t, "<home>", filepath.Join(work, "home"))
			args := []string{"-test.run=^TestRealRecordingChild$", "--", "literal argument", "--mode", "rpc"}
			env := append(os.Environ(), "BATON_RECORDING_CHILD=1", "BATON_RECORDING_VALUE=fixture-value")
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			run := func(path string) ([]byte, []byte) {
				t.Helper()
				cmd := exec.CommandContext(ctx, path, args...)
				cmd.Dir, cmd.Env = work, env
				var stdout, stderr bytes.Buffer
				cmd.Stdout, cmd.Stderr = &stdout, &stderr
				if err := cmd.Run(); err == nil || cmd.ProcessState.ExitCode() != 23 {
					t.Fatalf("夹具退出码丢失: %v", err)
				}
				return stdout.Bytes(), stderr.Bytes()
			}
			wantOut, wantErr := run(binary)
			gotOut, gotErr := run(r.binary)
			if !bytes.Equal(gotOut, wantOut) || !bytes.Equal(gotErr, wantErr) {
				t.Fatal("录制器改变了参数、环境或输出")
			}
			// 同一场景的恢复进程复用同一配置和原始文件。
			run(r.binary)
			f, err := os.Open(filepath.Join(os.Getenv("BATON_RECORD_DIR"), "codex", scenario+".raw.ndjson"))
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			raw, err := replay.ReadRaw(f)
			if err != nil {
				t.Fatal(err)
			}
			if raw.Header.Transcript.Scenario != scenario || raw.Header.Transcript.Agent != "codex" || raw.Header.Transcript.BatonCommit == "" || raw.Header.Bindings["<home>"] != filepath.Join(work, "home") {
				t.Fatal("场景元数据或路径绑定丢失")
			}
			starts, exits := 0, 0
			for _, e := range raw.Entries {
				if e.Type == "process_start" {
					starts++
					if !reflect.DeepEqual(e.Args, args) {
						t.Fatal("参数未原样传递")
					}
				}
				if e.Type == "runtime_exit" && e.Code == 23 {
					exits++
				}
			}
			if starts != 2 || exits != 2 {
				t.Fatalf("恢复进程未追加到本场景: starts=%d exits=%d", starts, exits)
			}
		})
	}
	t.Run("disabled", func(t *testing.T) {
		t.Setenv("BATON_RECORD_DIR", "")
		r := newRealRecording(t, realRecordingTool(t), "pi", "fixture", "fixture", binary, nil)
		if r.binary != binary || r.config != nil {
			t.Fatal("未开启录制时替换了 Agent")
		}
	})
}

func TestRealRecordingPiSandbox(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("需要 macOS sandbox-exec；不需要模型或数据库")
	}
	t.Setenv("BATON_RECORD_DIR", t.TempDir())
	tool := realRecordingTool(t)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"home", "work"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	profile, wrapper := filepath.Join(root, "pi.sb"), filepath.Join(root, "pi-isolated")
	if err := os.WriteFile(profile, []byte(piSandboxPolicy([]string{root}, []string{root}, filepath.Join(root, "ipc"))), 0o600); err != nil {
		t.Fatal(err)
	}
	writeRealPiWrapper(t, wrapper, profile, "/bin/sh")
	r := newRealRecording(t, tool, "pi", "fixture", "fixture", wrapper, map[string]string{"<workspace>": root})
	// 原始目录位于沙箱外：真实子进程的写入必须被拒绝，录制器仍能写出文件。
	outside := filepath.Join(os.Getenv("BATON_RECORD_DIR"), "forbidden")
	cmd := exec.Command(r.binary, "-c", `printf allowed > "$1"; if printf forbidden > "$2"; then exit 91; fi; printf 'sandboxed\n'`, "sh", filepath.Join(root, "work", "allowed"), outside)
	cmd.Dir = filepath.Join(root, "work")
	cmd.Env = []string{"HOME=" + filepath.Join(root, "home"), "TMPDIR=" + filepath.Join(root, "home"), "PATH=/usr/bin:/bin"}
	out, err := cmd.Output()
	if err != nil || string(out) != "sandboxed\n" {
		t.Fatalf("录制沙箱夹具失败: %v stderr=%q", err, func() []byte {
			if e, ok := err.(*exec.ExitError); ok {
				return e.Stderr
			}
			return nil
		}())
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatal("沙箱外文件被写入")
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("BATON_RECORD_DIR"), "pi", "TestRealRecordingPiSandbox.raw.ndjson")); err != nil {
		t.Fatal("沙箱阻止了外层录制器写入", err)
	}
}
