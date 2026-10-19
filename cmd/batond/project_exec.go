package main

import (
	"errors"
	"flag"
	"fmt"
	"io"

	"baton/internal/node"
	"baton/internal/protocol"
)

func cmdProjectExec(args []string, stdout io.Writer, getenv func(string) string) error {
	fs := flag.NewFlagSet("project-exec", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var dir, shell string
	var enabled bool
	fs.StringVar(&dir, "data-dir", "", "")
	fs.StringVar(&shell, "shell", node.DefaultProjectShell(), "")
	fs.BoolVar(&enabled, "enabled", false, "")
	if fs.Parse(args) != nil || fs.NArg() != 0 {
		return &exitCode{code: 2, err: errors.New(usage())}
	}
	set := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "enabled" {
			set = true
		}
	})
	if !set {
		return &exitCode{code: 2, err: errors.New("必须显式指定 --enabled=true 或 --enabled=false")}
	}
	var err error
	if dir == "" {
		dir, err = node.DefaultDataDir(getenv)
	}
	if err != nil {
		return err
	}
	if enabled {
		if _, err := fmt.Fprintln(stdout, "开启后，Project Agent 可以执行任意命令，以本设备用户身份运行。Baton 不提供沙箱；登记目录只限制启动位置，命令仍可访问目录之外的文件。任务结果或仓库内容中的恶意指令可能诱导执行任意命令。每条命令和输出都会保存到对话。只在信任 Project Agent 的设备上开启。"); err != nil {
			return err
		}
	}
	if err := node.WriteProjectExec(dir, protocol.RuntimeExec{Enabled: enabled, Shell: shell}); err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "Project Agent 命令执行：%t，shell：%s\n", enabled, shell)
	return err
}
