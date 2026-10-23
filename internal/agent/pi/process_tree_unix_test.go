//go:build !windows

package pi

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
)

func TestPiNaturalExitStopsDescendantHoldingOutput(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "pi")
	childFile := filepath.Join(dir, "child.pid")
	release := filepath.Join(dir, "exit")
	native := filepath.Join(dir, "native")
	sessionFile := filepath.Join(native, "session.jsonl")
	state, err := json.Marshal(map[string]any{"type": "response", "id": "baton-2", "command": "get_state", "success": true, "data": map[string]any{"sessionId": "process-tree", "sessionFile": sessionFile}})
	if err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf(`#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.3.0; exit 0; fi
sleep 60 &
echo "$!" > %q
IFS= read -r request
printf '%%s\n' '{"type":"response","id":"baton-1","command":"set_auto_retry","success":true}'
IFS= read -r request
printf '%%s\n' '%s'
while [ ! -e %q ]; do sleep 0.01; done
exit 0
`, childFile, state, release)
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	a := New(agent.Config{Binary: binary, Directory: dir, SessionDir: native, SessionID: "process-tree"})
	t.Cleanup(func() { _ = a.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(childFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		t.Fatalf("invalid child PID: %q", raw)
	}
	t.Cleanup(func() {
		p, err := os.FindProcess(pid)
		if err == nil {
			_ = p.Kill()
			_ = p.Release()
		}
	})
	if err := os.WriteFile(release, nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-a.done:
	case <-time.After(2 * time.Second):
		t.Fatal("Pi exited but its descendant kept protocol output open and blocked process-tree cleanup")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		raw, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
		if err != nil || strings.HasPrefix(strings.TrimSpace(string(raw)), "Z") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Pi descendant survived natural exit")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
