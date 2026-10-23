//go:build !windows

package gateway_test

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

func sessionWorkerStarting(ctx context.Context, dataDir, sessionID string) (bool, error) {
	commands, err := sessionCleanupCommands(dataDir, sessionID)
	if err != nil {
		return false, err
	}
	// ps 不转义参数；比较完整命令行，不对随机目录或 Session 做子串匹配。
	wanted := make(map[string]bool, len(commands))
	for _, args := range commands {
		wanted[strings.Join(args, " ")] = true
	}
	raw, err := exec.CommandContext(ctx, "ps", "-ww", "-axo", "args=").Output()
	if err != nil {
		return false, fmt.Errorf("查询测试 Worker 命令行: %w", errors.Join(ctx.Err(), err))
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if wanted[strings.TrimSpace(line)] {
			return true, nil
		}
	}
	return false, nil
}
