package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"testing"
	"time"

	"baton/internal/redact"
)

// 测试二进制可作为 Coordinator 子进程使用，Project Agent 租约为 3 秒。
func TestMain(m *testing.M) {
	if len(os.Args) < 2 {
		os.Exit(m.Run())
	}
	switch os.Args[1] {
	case "migrate", "serve", "admin":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		err := runWithOptions(ctx, os.Args[1:], os.Stdout, os.Stderr, os.Getenv, RunOptions{
			ProjectAgentLeaseDuration: 3 * time.Second,
		})
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

func TestCoordinatorProcessCLI(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, executable, "admin").CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 2 || !strings.Contains(string(output), "baton-server serve") {
		t.Fatalf("测试二进制未按 CLI 返回用法错误: %s, %v", output, err)
	}
}
