// agent-replay 通过旁置配置文件为适配器提供转录回放进程。
package main

import (
	"context"
	"flag"
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
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "normalize" {
		flags := flag.NewFlagSet("normalize", flag.ContinueOnError)
		input := flags.String("input", "", "原始录制路径")
		output := flags.String("output", "", "转录输出路径")
		if err := flags.Parse(args[1:]); err != nil {
			os.Exit(1)
		}
		if *input == "" || *output == "" || flags.NArg() != 0 {
			fmt.Fprintln(os.Stderr, "用法: agent-replay normalize --input raw.ndjson --output transcript.ndjson")
			os.Exit(1)
		}
		if err := replay.NormalizeFile(*input, *output); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		// 原始录制只用于本机临时处理，成功写出后删除。
		if err := os.Remove(*input); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	var exit replay.Exit
	_, recordErr := os.Stat(executable + ".record.json")
	recording := len(args) > 0 && args[0] == "record"
	if recording || (recordErr == nil && (len(args) == 0 || args[0] != "serve")) {
		if recording {
			args = args[1:]
		}
		config, loadErr := replay.LoadRecordConfig(executable)
		if loadErr != nil {
			fmt.Fprintln(os.Stderr, loadErr)
			os.Exit(1)
		}
		exit, err = replay.Record(context.Background(), config, args, os.Stdin, os.Stdout, os.Stderr)
	} else {
		config, loadErr := replay.LoadConfig(executable)
		if loadErr != nil {
			fmt.Fprintln(os.Stderr, loadErr)
			os.Exit(1)
		}
		// 直接充当 Agent 时没有子命令；显式 serve 使用同一份旁置配置。
		if len(args) > 0 && args[0] == "serve" {
			args = args[1:]
		}
		exit, err = replay.Serve(context.Background(), config, args, os.Stdin, os.Stdout, os.Stderr)
	}
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
