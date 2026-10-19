package shell

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/fileaccess"
	"baton/internal/projectexec"
	"baton/internal/protocol"
	"baton/internal/task"
)

func configured(t *testing.T) (*Adapter, string) {
	t.Helper()
	data, root := t.TempDir(), t.TempDir()
	shell := "/bin/sh"
	if runtime.GOOS == "windows" {
		shell = "pwsh"
	}
	if err := projectexec.WriteProjectExec(data, protocol.RuntimeExec{Enabled: true, Shell: shell}); err != nil {
		t.Fatal(err)
	}
	if err := fileaccess.AddBrowseRoot(data, "workspace", root); err != nil {
		t.Fatal(err)
	}
	a := New(agent.Config{DataDir: data, Directory: root, SessionDir: filepath.Join(data, "native")})
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := a.Close(); err != nil {
			t.Error(err)
		}
	})
	return a, root
}
func submit(t *testing.T, a *Adapter, command string) agent.Output {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"description": command, "generation": 1})
	out, err := a.SubmitInput(context.Background(), string(payload))
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func result(t *testing.T, a *Adapter, out agent.Output) task.Candidate {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !out.Exited && time.Now().Before(deadline) {
		outputs := a.Drain()
		if len(outputs) > 0 {
			out = outputs[0]
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !out.Exited {
		t.Fatal("命令没有结束")
	}
	got, err := task.ParseCandidate(out.Final)
	if err != nil {
		t.Fatalf("无效的命令结果: %v %s", err, out.Final)
	}
	if got.CommandResult == nil {
		t.Fatal("缺少命令结果")
	}
	return got
}
func TestCommandSuccessFailureAndHistory(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{true: "failure", false: "success"}[failed], func(t *testing.T) {
			a, _ := configured(t)
			command := "printf 'stdout'; printf 'stderr' >&2"
			if runtime.GOOS == "windows" {
				command = "[Console]::Out.Write('stdout'); [Console]::Error.Write('stderr')"
			}
			if failed {
				command += "; exit 7"
			}
			initial := submit(t, a, command)
			if initial.Final != "" {
				t.Fatal("命令启动阻塞了 Worker")
			}
			got := result(t, a, initial)
			wantStatus, wantCode := task.StatusCompleted, 0
			if failed {
				wantStatus, wantCode = task.StatusFailed, 7
			}
			if got.Status != wantStatus || got.CommandResult.ExitCode != wantCode || got.CommandResult.TotalBytes != 12 || !strings.Contains(got.CommandResult.Output, "stdout") || !strings.Contains(got.CommandResult.Output, "stderr") {
				t.Fatalf("命令结果不正确: %+v %+v", got, *got.CommandResult)
			}
			page, err := a.ReadHistory(context.Background(), "")
			if err != nil || !strings.Contains(string(page.Data), "stdout") {
				t.Fatalf("输出没有保存在本地: %s %v", page.Data, err)
			}
			if contains, err := a.HistoryContains("delivery", false); contains || err != nil {
				t.Fatal("命令错误地确认了子任务投递")
			}
			if _, err := a.DeliverResult(context.Background(), "delivery", "{}"); err == nil {
				t.Fatal("命令接受了子任务结果")
			}
			if _, err := a.SubmitInput(context.Background(), `{"description":"exit 0","generation":1}`); err == nil {
				t.Fatal("同一个执行接受了第二条命令")
			}
		})
	}
}
func TestExecutionRechecksLocalAuthorization(t *testing.T) {
	for _, change := range []string{"disabled", "corrupt", "root_removed", "outside", "missing", "symlink_escape", "missing_shell"} {
		t.Run(change, func(t *testing.T) {
			a, root := configured(t)
			marker := filepath.Join(root, "must-not-exist")
			switch change {
			case "disabled":
				if err := projectexec.WriteProjectExec(a.config.DataDir, protocol.RuntimeExec{Enabled: false, Shell: projectexec.DefaultProjectShell()}); err != nil {
					t.Fatal(err)
				}
			case "corrupt":
				if err := os.WriteFile(filepath.Join(a.config.DataDir, projectexec.FileName), []byte("invalid"), 0600); err != nil {
					t.Fatal(err)
				}
			case "root_removed":
				if err := fileaccess.RemoveBrowseRoot(a.config.DataDir, "workspace"); err != nil {
					t.Fatal(err)
				}
			case "outside":
				a.config.Directory = t.TempDir()
			case "missing":
				a.config.Directory = filepath.Join(root, "absent")
			case "symlink_escape":
				if runtime.GOOS == "windows" {
					t.Skip("符号链接需要 Windows 开发者模式；目录撤回和越界仍运行")
				}
				link := filepath.Join(root, "escape")
				if err := os.Symlink(t.TempDir(), link); err != nil {
					t.Fatal(err)
				}
				a.config.Directory = link
			case "missing_shell":
				if err := projectexec.WriteProjectExec(a.config.DataDir, protocol.RuntimeExec{Enabled: true, Shell: filepath.Join(root, "missing-shell")}); err != nil {
					t.Fatal(err)
				}
			}
			command := "touch '" + marker + "'"
			if runtime.GOOS == "windows" {
				command = "Set-Content -LiteralPath '" + strings.ReplaceAll(marker, "'", "''") + "' -Value 'bad'"
			}
			got := result(t, a, submit(t, a, command))
			if got.Status != task.StatusFailed || got.CommandResult.ExitCode != -1 {
				t.Fatalf("未明确拒绝启动: %+v", got)
			}
			if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("授权失效后执行了命令")
			}
		})
	}
}
func TestRestoreNeverRestartsCommand(t *testing.T) {
	a, _ := configured(t)
	restored := New(agent.Config{Restore: true, SessionDir: a.config.SessionDir})
	if err := restored.Start(context.Background()); !errors.Is(err, agent.ErrHistoryMissing) {
		t.Fatalf("恢复结果: %v", err)
	}
}
func TestBoundedOutputRetainsExactHeadTailAndRawByteCount(t *testing.T) {
	for _, size := range []int{0, 100, 16 * 1024, 32 * 1024, 32*1024 + 1, 100 * 1024} {
		raw := strings.Repeat("a", size/2) + strings.Repeat("z", size-size/2)
		for _, chunk := range []int{1, 777, 64 * 1024} {
			b := &boundedOutput{}
			for start := 0; start < len(raw); start += chunk {
				_, _ = b.Write([]byte(raw[start:min(start+chunk, len(raw))]))
			}
			got := b.result(0)
			want := raw
			if size > task.CommandOutputBytes {
				want = raw[:task.CommandOutputBytes/2] + raw[len(raw)-task.CommandOutputBytes/2:]
			}
			if got.Output != want || got.TotalBytes != int64(size) || got.Truncated != (size > task.CommandOutputBytes) {
				t.Fatalf("size=%d chunk=%d retained=%d total=%d", size, chunk, len(got.Output), got.TotalBytes)
			}
		}
	}
	b := &boundedOutput{}
	_, _ = b.Write([]byte{'a', 0, 1, 0xff, '\n', '\t'})
	got := b.result(0)
	decoded, err := base64.StdEncoding.DecodeString(got.Output)
	if err != nil || got.Encoding != "base64" || string(decoded) != string([]byte{'a', 0, 1, 0xff, '\n', '\t'}) || got.TotalBytes != 6 {
		t.Fatalf("二进制输出没有转换为文本: %+v", got)
	}
}
func TestCommandOutputIsBoundedInRealProcess(t *testing.T) {
	a, _ := configured(t)
	command := "i=0; while [ $i -lt 40000 ]; do printf a; i=$((i+1)); done; printf END"
	if runtime.GOOS == "windows" {
		command = "[Console]::Out.Write(('a' * 40000) + 'END')"
	}
	got := result(t, a, submit(t, a, command)).CommandResult
	if got.TotalBytes != 40003 || !got.Truncated || len(got.Output) != task.CommandOutputBytes || !strings.HasSuffix(got.Output, "END") {
		t.Fatalf("真实进程输出截断不正确: %+v", got)
	}
}

func TestOutputEncodingBoundsEscapedPayload(t *testing.T) {
	for _, raw := range []string{strings.Repeat("<", task.CommandOutputBytes), strings.Repeat("\\", task.CommandOutputBytes), strings.Repeat("\x00", task.CommandOutputBytes), "\u0085"} {
		b := &boundedOutput{}
		_, _ = b.Write([]byte(raw))
		got := b.result(0)
		if got.Encoding != "base64" {
			t.Fatalf("应使用base64保留输出，实际encoding=%s bytes=%d", got.Encoding, len(got.Output))
		}
		decoded, err := base64.StdEncoding.DecodeString(got.Output)
		if err != nil || string(decoded) != raw {
			t.Fatal("输出编码改变了保留字节")
		}
		out := formatResult(got, "")
		if _, err := task.ParseCandidate(out.Final); err != nil {
			t.Fatal(err)
		}
		nested, _ := json.Marshal(out.Final)
		if len(nested) > 64*1024 {
			t.Fatalf("编码后的结果不能进入消息: %d", len(nested))
		}
	}
}
