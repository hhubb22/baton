package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"testing"

	"baton/internal/agent/codex"
	"baton/internal/agent/kiro"
	"baton/internal/agent/pi"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/redact"
)

// 测试二进制可作为 batond 子进程使用，模型目录由内存中的探测函数提供。
func TestMain(m *testing.M) {
	if len(os.Args) < 2 {
		os.Exit(m.Run())
	}
	switch os.Args[1] {
	case "register", "run", "files", "project-exec", "sidecar-file", "worker":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		opts := node.RunOptions{
			DiscoverRuntimeModels: func(context.Context, string, string) ([]protocol.RuntimeModel, string, error) {
				return []protocol.RuntimeModel{}, "", nil
			},
			ProbeRuntimeAgentVersion: func(_ context.Context, path string) (string, error) {
				for _, agent := range []struct{ env, version string }{
					{"BATON_PI_BIN", pi.Version},
					{"BATON_CODEX_BINARY", codex.Version},
					{"BATON_KIRO_BINARY", kiro.Version},
				} {
					if path == os.Getenv(agent.env) {
						return agent.version, nil
					}
				}
				return "", errors.New("未配置此 Agent 的版本探测")
			},
		}
		err := runWithOptions(ctx, os.Args[1:], os.Stdout, os.Stderr, os.Getenv, opts)
		stop()
		if err != nil {
			fmt.Fprintln(os.Stderr, redact.Scrub(err.Error()))
			var coded *exitCode
			if errors.As(err, &coded) {
				os.Exit(coded.code)
			}
			os.Exit(1)
		}
		os.Exit(0)
	default:
		os.Exit(m.Run())
	}
}
