//go:build windows

package shell

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestPowerShellCancellationStopsJobObjectProcessTree(t *testing.T) {
	a, root := configured(t)
	binary, err := exec.LookPath("pwsh")
	if err != nil {
		t.Fatal("Windows 原生验证需要 PowerShell 7:", err)
	}
	pidPath := filepath.Join(root, "child.pid")
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	command := "[Console]::Out.Write('before-stop'); $child = Start-Process -FilePath " + quote(binary) + " -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 300' -PassThru; [IO.File]::WriteAllText(" + quote(pidPath) + ", $child.Id.ToString()); Wait-Process -Id $child.Id"
	submit(t, a, command)
	var child uint64
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		raw, _ := os.ReadFile(pidPath)
		child, _ = strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 32)
		if child > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if child == 0 {
		t.Fatal("PowerShell 没有生成子进程")
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(child))
	if err != nil {
		t.Fatal("无法观察 PowerShell 子进程:", err)
	}
	defer windows.CloseHandle(handle)
	if state, err := windows.WaitForSingleObject(handle, 0); err != nil || state != uint32(windows.WAIT_TIMEOUT) {
		t.Fatalf("子进程在取消前已退出: %d %v", state, err)
	}
	stopped, known, err := a.Abort()
	if err != nil || !stopped || known {
		t.Fatalf("取消结果: stopped=%v known=%v err=%v", stopped, known, err)
	}
	assertStoppedRecovery(t, a)
	if state, err := windows.WaitForSingleObject(handle, 5000); err != nil || state != windows.WAIT_OBJECT_0 {
		t.Fatalf("Job Object 关闭后子进程仍运行: %d %v", state, err)
	}
}
