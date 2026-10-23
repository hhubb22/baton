// Package projectruntime locates the Project Agent Runtime and reads its local capabilities.
package projectruntime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"time"

	"baton/internal/protocol"
	"baton/internal/sidecar"
)

const Version = "0.1.0"

// Command uses the bundled Runtime or the standalone executable on PATH.
// The native host handles private credential files on Windows.
func Command(ctx context.Context, args ...string) (*exec.Cmd, error) {
	resolved, err := sidecar.Command(ctx, "project-agent", Version, "baton-project-runtime", args...)
	if err != nil {
		return nil, fmt.Errorf("无法启动 Project Runtime，请检查 batond 完整安装包和 Node.js：%w", err)
	}
	host, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, resolved.Path, resolved.Args[1:]...)
	cmd.Env = append(os.Environ(), "BATON_SIDECAR_HOST="+host)
	return cmd, nil
}

// Probe reads local credential status and model catalogs without refreshing tokens or requesting inference.
func Probe(ctx context.Context) (*protocol.ProjectRuntime, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	cmd, err := Command(ctx, "probe")
	if err != nil {
		return nil, err
	}
	out, err := sidecar.Capture(ctx, cmd, 16<<10)
	if err != nil {
		return nil, errors.New("Project Runtime 状态检查失败，请检查安装和凭据目录权限")
	}
	return decodeProbe(out)
}

func decodeProbe(raw []byte) (*protocol.ProjectRuntime, error) {
	var report protocol.ProjectRuntime
	if protocol.DecodeRuntimeMessage(raw, &report) != nil || protocol.ValidateProjectRuntime(&report) != nil || report.Version != Version {
		return nil, errors.New("Project Runtime 状态报告无效或版本不匹配，请检查安装包")
	}
	sort.Slice(report.Providers, func(i, j int) bool { return report.Providers[i].Provider < report.Providers[j].Provider })
	return &report, nil
}
