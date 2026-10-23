package gateway_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

// sessionCleanupCommands 只接受本测试 data-dir 对应节点的 Worker，以及当前测试二进制的专用 helper。
func sessionCleanupCommands(dataDir, sessionID string) ([][]string, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	suffix := []string{"worker", "--data-dir", dataDir, "--session", sessionID}
	commands := [][]string{append([]string{exe, "-test.run=^TestSessionCleanupDelayedWorkerHelper$", "-test.timeout=10s"}, suffix...)}
	processMu.Lock()
	defer processMu.Unlock()
	for _, handles := range processHandles {
		for _, p := range handles {
			args := p.cmd.Args
			if len(args) < 2 || args[1] != "run" {
				continue
			}
			for i := 2; i+1 < len(args); i++ {
				if args[i] == "--data-dir" && args[i+1] == dataDir {
					absolute, err := filepath.Abs(p.cmd.Path)
					if err != nil {
						return nil, err
					}
					resolved, err := filepath.EvalSymlinks(absolute)
					if err != nil {
						return nil, err
					}
					commands = append(commands, append([]string{absolute}, suffix...))
					if resolved != absolute {
						commands = append(commands, append([]string{resolved}, suffix...))
					}
					break
				}
			}
		}
	}
	return commands, nil
}

func TestSessionCleanupCommandsNormalizeRegisteredBinary(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "batond with spaces")
	if err := os.WriteFile(binary, nil, 0600); err != nil {
		t.Fatal(err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	relative, err := filepath.Rel(cwd, binary)
	if err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Join(dir, "node")
	const sessionID = "session-command-scope"
	cmd := exec.Command(relative, "run", "--data-dir", dataDir)
	trackProcess(t, &running{cmd: cmd, bin: relative})
	// 未属于目标 data-dir 的登记项不能进入候选，也不应尝试解析它的不存在路径。
	other := exec.Command(filepath.Join(dir, "missing"), "run", "--data-dir", dataDir+"-other")
	trackProcess(t, &running{cmd: other, bin: other.Path})
	commands, err := sessionCleanupCommands(dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	absolute, err := filepath.Abs(binary)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{absolute, resolved} {
		found := false
		for _, args := range commands {
			if !filepath.IsAbs(args[0]) {
				t.Fatalf("候选仍使用相对可执行路径: %q", args[0])
			}
			if args[0] == want && slices.Equal(args[1:], []string{"worker", "--data-dir", dataDir, "--session", sessionID}) {
				found = true
			}
		}
		if !found {
			t.Fatalf("缺少绑定目标目录和 Session 的绝对候选: %q", want)
		}
	}
}
