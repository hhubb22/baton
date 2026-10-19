// 本程序在进程测试中启动实际 Pi Runtime，模型由 pi-ai faux provider 提供。
package main

import (
	"fmt"
	"os"
	"os/exec"
)

func main() {
	if len(os.Args) != 2 {
		os.Exit(2)
	}
	if os.Args[1] == "probe" {
		fmt.Print(`{"version":"0.1.0","providers":[{"provider":"openai-codex","status":"available"}]}`)
		return
	}
	cmd := exec.Command(os.Getenv("BATON_TEST_RUNTIME_NODE"), "--import", os.Getenv("BATON_TEST_RUNTIME_LOADER"), os.Getenv("BATON_TEST_RUNTIME_WORKER"))
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if cmd.Run() != nil {
		os.Exit(1)
	}
}
