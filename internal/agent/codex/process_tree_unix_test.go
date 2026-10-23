//go:build !windows

package codex

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
)

func TestAdapterProcessTreeHelper(t *testing.T) {
	binary := os.Getenv("BATON_TEST_AGENT_TREE_BINARY")
	if binary == "" {
		return
	}
	a := New(agent.Config{Binary: binary, Directory: filepath.Dir(binary), Env: os.Environ()})
	defer a.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary+".ready", nil, 0600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Minute)
}

func lifecycleCLI(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	binary, child := filepath.Join(dir, "agent"), filepath.Join(dir, "child.pid")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.163.0'
  exit 0
fi
sleep 60 &
echo "$!" > "$CHILD_PID_FILE"
IFS= read -r request
printf '%s\n' '{"jsonrpc":"2.0","id":0,"result":{"userAgent":"fixture"}}'
while IFS= read -r request; do
  case "$request" in
    *'"method":"fixture/exit"'*) exit 0 ;;
  esac
done
wait
`
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	return binary, child
}

func waitLifecycleFact(t *testing.T, fact func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !fact() {
		if time.Now().After(deadline) {
			t.Fatal("等待进程树事实超时")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func lifecycleChild(t *testing.T, path string) int {
	t.Helper()
	var pid int
	waitLifecycleFact(t, func() bool {
		raw, err := os.ReadFile(path)
		if err != nil {
			return false
		}
		pid, err = strconv.Atoi(strings.TrimSpace(string(raw)))
		return err == nil && pid > 0
	})
	t.Cleanup(func() {
		p, err := os.FindProcess(pid)
		if err == nil {
			_ = p.Kill()
			_ = p.Release()
		}
	})
	return pid
}

func waitLifecycleChildExit(t *testing.T, pid int) {
	t.Helper()
	waitLifecycleFact(t, func() bool {
		raw, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
		return err != nil || strings.HasPrefix(strings.TrimSpace(string(raw)), "Z")
	})
}

func TestAdapterNaturalExitStopsDescendants(t *testing.T) {
	binary, childFile := lifecycleCLI(t)
	a := New(agent.Config{Binary: binary, Directory: filepath.Dir(binary), Env: append(os.Environ(), "CHILD_PID_FILE="+childFile)})
	t.Cleanup(func() { _ = a.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.connect(ctx); err != nil {
		t.Fatal(err)
	}
	child := lifecycleChild(t, childFile)
	if err := a.conn.Notify(ctx, "fixture/exit", nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-a.processDone:
	case <-ctx.Done():
		t.Fatal("Agent 自然退出未完成回收")
	}
	waitLifecycleChildExit(t, child)
}

func TestAdapterOwnerCrashStopsDescendants(t *testing.T) {
	binary, childFile := lifecycleCLI(t)
	owner := exec.Command(os.Args[0], "-test.run=^TestAdapterProcessTreeHelper$")
	owner.Env = append(os.Environ(), "BATON_TEST_AGENT_TREE_BINARY="+binary, "CHILD_PID_FILE="+childFile)
	if err := owner.Start(); err != nil {
		t.Fatal(err)
	}
	ownerDone := make(chan struct{})
	go func() { _ = owner.Wait(); close(ownerDone) }()
	t.Cleanup(func() { _ = owner.Process.Kill(); <-ownerDone })
	waitLifecycleFact(t, func() bool { _, err := os.Stat(binary + ".ready"); return err == nil })
	child := lifecycleChild(t, childFile)
	if err := owner.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-ownerDone
	waitLifecycleChildExit(t, child)
}
