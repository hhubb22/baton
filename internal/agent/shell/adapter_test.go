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

	"baton/internal/agent"
	"baton/internal/fileaccess"
	"baton/internal/identity"
	"baton/internal/projectexec"
	"baton/internal/protocol"
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
	sessionID, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	a := New(agent.Config{DataDir: data, Directory: root, SessionDir: filepath.Join(data, "sessions", sessionID, "native"), SessionID: sessionID})
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
			if len(initial) != 0 {
				t.Fatal("命令启动阻塞了 Worker")
			}
			got := result(t, a, initial)
			wantCode := 0
			if failed {
				wantCode = 7
			}
			if got.ExitCode != wantCode || got.TotalBytes != 12 || !strings.Contains(got.Output, "stdout") || !strings.Contains(got.Output, "stderr") {
				t.Fatal(got)
			}

			page, err := a.ReadHistory(context.Background(), "")
			if err != nil || !strings.Contains(string(page.Data), "stdout") {
				t.Fatalf("输出没有保存在本地: %s %v", page.Data, err)
			}
			if err := a.Send(context.Background(), "second", "exit 0", ""); err == nil {
				t.Fatal("second command accepted")
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
			err := a.Send(context.Background(), "denied", command, "")
			if err == nil {
				t.Fatal("未明确拒绝启动")
			}
			if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("授权失效后执行了命令")
			}
		})
	}
}
func TestRestoreNeverRestartsCommand(t *testing.T) {
	a, _ := configured(t)
	config := a.config
	config.Restore = true
	restored := New(config)
	if err := restored.Start(context.Background()); !errors.Is(err, agent.ErrHistoryMissing) {
		t.Fatalf("恢复结果: %v", err)
	}
	if err := restored.Send(context.Background(), "message", "exit 0", ""); err == nil {
		t.Fatal("恢复缺少完成记录的执行时重新接受了输入")
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
			if size > commandOutputBytes {
				want = raw[:commandOutputBytes/2] + raw[len(raw)-commandOutputBytes/2:]
			}
			if got.Output != want || got.TotalBytes != int64(size) || got.Truncated != (size > commandOutputBytes) {
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
	got := result(t, a, submit(t, a, command))
	if got.TotalBytes != 40003 || !got.Truncated || len(got.Output) != commandOutputBytes || !strings.HasSuffix(got.Output, "END") {
		t.Fatalf("真实进程输出截断不正确: %+v", got)
	}
}

func TestOutputEncodingBoundsEscapedPayload(t *testing.T) {
	for _, raw := range []string{strings.Repeat("<", commandOutputBytes), strings.Repeat("\\", commandOutputBytes), strings.Repeat("\x00", commandOutputBytes), "\u0085"} {
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
		nested, _ := json.Marshal(got)
		if len(nested) > 64*1024 {
			t.Fatalf("编码后的结果不能进入消息: %d", len(nested))
		}
	}
}

func submit(t *testing.T, a *Adapter, command string) []agent.Event {
	t.Helper()
	if err := a.Send(context.Background(), "message", command, ""); err != nil {
		t.Fatal(err)
	}
	return nil
}
func result(t *testing.T, a *Adapter, _ []agent.Event) commandOutput {
	t.Helper()
	events := threadEvents(t, a)
	for _, e := range events {
		if e.Kind == agent.EventReply {
			var meta struct {
				ExitCode int `json:"exit_code"`
				Encoding string
			}
			if err := json.Unmarshal(e.Metadata, &meta); err != nil {
				t.Fatal(err)
			}
			return commandOutput{Encoding: meta.Encoding, ExitCode: meta.ExitCode, Output: e.Content, TotalBytes: e.OriginalBytes, Truncated: e.Truncated}
		}
	}
	t.Fatal("missing reply", events)
	return commandOutput{}
}
