// 本程序验证 batond 的进程管理和身份绑定，不发送模型请求。
package main

import (
	"encoding/json"
	"net"
	"os"
	"runtime"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	if os.Args[1] == "probe" {
		status := "available"
		if os.Getenv("BATON_TEST_PROJECT_LOGIN_REQUIRED") == "1" {
			status = "login_required"
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"version": "test-1", "providers": []any{map[string]string{"provider": "test", "status": status}}})
		return
	}
	files, _ := os.ReadDir(".")
	log, _ := os.OpenFile(os.Getenv("BATON_TEST_PROJECT_RUNTIME_LOG"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if log != nil {
		_ = json.NewEncoder(log).Encode(map[string]any{"pid": os.Getpid(), "files": len(files)})
		log.Close()
	}
	if runtime.GOOS != "windows" {
		conn, err := net.Dial("unix", os.Getenv("BATON_PROJECT_RUNTIME_ENDPOINT"))
		if err == nil {
			_ = json.NewEncoder(conn).Encode(map[string]any{"token": os.Getenv("BATON_PROJECT_RUNTIME_TOKEN"), "request": map[string]any{"operation": "bootstrap", "run_id": "forged", "lease_epoch": 999}})
			var result any
			_ = json.NewDecoder(conn).Decode(&result)
			conn.Close()
		}
	}
	for {
		time.Sleep(time.Second)
	}
}
