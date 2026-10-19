//go:build !windows

package node

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func TestProjectRuntimeGuardianHelper(t *testing.T) {
	path := os.Getenv("BATON_TEST_GUARDIAN_PATH")
	if path == "" {
		return
	}
	cmd := exec.Command("/bin/sh", "-c", `while :; do echo live >> "$1"; sleep 0.02; done`, "runtime", path)
	stop, err := startProjectRuntimeProcess(cmd)
	if err != nil {
		os.Exit(2)
	}
	defer stop()
	if os.WriteFile(path+".pid", []byte(strconv.Itoa(cmd.Process.Pid)), 0600) != nil {
		os.Exit(3)
	}
	for {
		time.Sleep(time.Second)
	}
}

func TestProjectRuntimeGuardianStopsOrphanAfterDaemonCrash(t *testing.T) {
	path := filepath.Join(t.TempDir(), "progress")
	helper := exec.Command(os.Args[0], "-test.run=^TestProjectRuntimeGuardianHelper$")
	helper.Env = append(os.Environ(), "BATON_TEST_GUARDIAN_PATH="+path)
	if err := helper.Start(); err != nil {
		t.Fatal(err)
	}
	defer helper.Process.Kill()
	deadline := time.Now().Add(3 * time.Second)
	var pid int
	for {
		raw, err := os.ReadFile(path + ".pid")
		if err == nil {
			pid, _ = strconv.Atoi(string(raw))
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("守护测试进程未启动")
		}
		time.Sleep(10 * time.Millisecond)
	}
	defer syscall.Kill(-pid, syscall.SIGKILL)
	for {
		info, err := os.Stat(path)
		if err == nil && info.Size() > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Runtime未运行")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := helper.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	helper.Wait()
	time.Sleep(150 * time.Millisecond)
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if before.Size() != after.Size() {
		t.Fatal("batond崩溃后Runtime仍在运行")
	}
}
