//go:build !windows

package shell

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestCancelStopsWholeProcessGroup(t *testing.T) {
	a, root := configured(t)
	pidPath := filepath.Join(root, "child.pid")
	command := "sleep 300 & child=$!; printf '%s' \"$child\" > '" + strings.ReplaceAll(pidPath, "'", "'\\''") + "'; wait \"$child\""
	submit(t, a, command)
	var child int
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		raw, _ := os.ReadFile(pidPath)
		child, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
		if child > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if child <= 0 {
		t.Fatal("命令没有生成子进程")
	}
	stopped, known, err := a.Abort()
	if err != nil || !stopped || known {
		t.Fatalf("取消结果: stopped=%v known=%v err=%v", stopped, known, err)
	}
	for time.Now().Before(deadline) {
		if err := syscall.Kill(child, 0); err != nil {
			return
		}
		raw, _ := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(child)).Output()
		if strings.HasPrefix(strings.TrimSpace(string(raw)), "Z") {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("取消后子进程 %d 仍在运行", child)
}
