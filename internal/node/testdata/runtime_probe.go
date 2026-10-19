// 本程序只用于 probe 契约测试，不实现 Runtime 或登录流程。
package main

import (
	"fmt"
	"os"
	"strings"
	"time"
)

func main() {
	if len(os.Args) != 2 || os.Args[1] != "probe" {
		os.Exit(2)
	}
	raw, err := os.ReadFile(os.Getenv("BATON_TEST_PROBE_FILE"))
	if err != nil {
		os.Exit(3)
	}
	switch string(raw) {
	case "slow":
		time.Sleep(10 * time.Second)
	case "flood":
		fmt.Print(strings.Repeat("x", 2<<20))
	case "error":
		fmt.Fprintln(os.Stderr, "secret-must-not-leave-node")
		os.Exit(1)
	default:
		fmt.Print(string(raw))
	}
}
