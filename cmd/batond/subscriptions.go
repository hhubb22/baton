package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"

	"baton/internal/protocol"
)

func cmdLogin(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer, command func(context.Context, ...string) (*exec.Cmd, error)) error {
	if len(args) != 1 || (args[0] != "openai-codex" && args[0] != "xai") {
		return &exitCode{code: 2, err: errors.New("用法：batond login openai-codex|xai（ChatGPT 使用 openai-codex）")}
	}
	cmd, err := command(ctx, "login", args[0])
	if err != nil {
		return err
	}
	// 继承当前终端的进程组，让 Runtime 直接读取交互输入。
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			code := exited.ExitCode()
			if code < 1 {
				code = 1
			}
			return &exitCode{code: code, err: errors.New("订阅登录未完成，请检查授权提示后重试")}
		}
		return errors.New("无法启动订阅登录，请检查 Project Runtime 安装")
	}
	_, err = fmt.Fprintln(stdout, "可运行 batond subscriptions 查看订阅状态；在线设备会自动上报登录状态。")
	return err
}

func cmdSubscriptions(ctx context.Context, args []string, stdout io.Writer, probe func(context.Context) (*protocol.ProjectRuntime, error)) error {
	if len(args) != 0 {
		return &exitCode{code: 2, err: errors.New("用法：batond subscriptions")}
	}
	report, err := probe(ctx)
	if err != nil {
		return err
	}
	if len(report.Providers) == 0 {
		_, err = fmt.Fprintln(stdout, "Project Runtime 未报告订阅服务。")
		return err
	}
	for _, provider := range report.Providers {
		name := provider.Provider
		switch provider.Provider {
		case "openai-codex":
			name += " (ChatGPT)"
		case "xai":
			name += " (xAI)"
		}
		var status string
		switch provider.Status {
		case "available":
			status = "已登录"
		case "login_required":
			status = "需要登录；运行 batond login " + provider.Provider
		case "unknown":
			status = "无法读取登录状态，请检查 Runtime 凭据目录的权限"
		}
		if _, err := fmt.Fprintf(stdout, "%s: %s\n", name, status); err != nil {
			return err
		}
	}
	return nil
}
