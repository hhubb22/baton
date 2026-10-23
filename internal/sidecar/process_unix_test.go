//go:build !windows

package sidecar

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func TestProcessTreePreservesChildExitStatus(t *testing.T) {
	for _, script := range []string{"exit 23", "kill -KILL $$"} {
		t.Run(script, func(t *testing.T) {
			cmd := exec.Command("/bin/sh", "-c", script)
			process, err := Start(cmd)
			if err != nil {
				t.Fatal(err)
			}
			defer process.Stop()
			var exit *exec.ExitError
			if err := process.Wait(); !errors.As(err, &exit) {
				t.Fatalf("expected child exit status, got %v", err)
			}
			status := exit.Sys().(syscall.WaitStatus)
			if script == "exit 23" {
				if status.ExitStatus() != 23 {
					t.Fatalf("exit status = %v", status)
				}
			} else if !status.Signaled() || status.Signal() != syscall.SIGKILL {
				t.Fatalf("child signal was not preserved: %v", status)
			}
		})
	}
}

func TestProcessTreeGuardianDoesNotKeepProtocolOutputOpen(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c", "printf ready")
	var output bytes.Buffer
	cmd.Stdout = &output
	process, err := Start(cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Stop()
	done := make(chan error, 1)
	go func() { done <- process.Wait() }()
	select {
	case err := <-done:
		if err != nil || output.String() != "ready" {
			t.Fatalf("output=%q err=%v", output.String(), err)
		}
	case <-time.After(3 * time.Second):
		process.Stop()
		<-done
		t.Fatal("guardian kept the protocol output pipe open after child exit")
	}
}

func TestProcessTreeGuardianHelper(t *testing.T) {
	path := os.Getenv("BATON_TEST_PROCESS_GUARDIAN_PATH")
	if path == "" {
		return
	}
	cmd := exec.Command("/bin/sh", "-c", `while :; do echo live >> "$1"; sleep 0.02; done`, "runtime", path)
	stop, err := StartTree(cmd)
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

func TestProcessTreeGuardianStopsOrphanAfterDaemonCrash(t *testing.T) {
	path := filepath.Join(t.TempDir(), "progress")
	helper := exec.Command(os.Args[0], "-test.run=^TestProcessTreeGuardianHelper$")
	helper.Env = append(os.Environ(), "BATON_TEST_PROCESS_GUARDIAN_PATH="+path)
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
			t.Fatal("进程树未运行")
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
		t.Fatal("父进程崩溃后进程树仍在运行")
	}
}
