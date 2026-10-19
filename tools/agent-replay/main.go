// agent-replay 通过旁置配置文件为适配器提供转录回放进程。
package main

import (
	"context"
	"fmt"
	"os"

	"baton/internal/agent/replay"
)

func main() {
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	config, err := replay.LoadConfig(executable)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	args := os.Args[1:]
	// 直接充当 Agent 时没有子命令；显式 serve 使用同一份旁置配置。
	if len(args) > 0 && args[0] == "serve" {
		args = args[1:]
	}
	exit, err := replay.Serve(context.Background(), config, args, os.Stdin, os.Stdout, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	if exit.Signal == "SIGKILL" {
		process, err := os.FindProcess(os.Getpid())
		if err == nil {
			_ = process.Kill()
		}
		os.Exit(137)
	}
	os.Exit(exit.Code)
}
