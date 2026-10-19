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
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"version": "0.1.0", "providers": []any{map[string]string{"provider": "test", "status": status}}})
		return
	}
	files, _ := os.ReadDir(".")
	log, _ := os.OpenFile(os.Getenv("BATON_TEST_PROJECT_RUNTIME_LOG"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if log != nil {
		_ = json.NewEncoder(log).Encode(map[string]any{"pid": os.Getpid(), "files": len(files)})
		log.Close()
	}
	if os.Getenv("BATON_TEST_PROJECT_STDIO") == "1" {
		decoder := json.NewDecoder(os.Stdin)
		for id, operation := range []string{"", "wrong_type", "bootstrap", "preview", "call_tool", "wait_tool", "renew", "finish"} {
			req := map[string]any{"operation": operation, "run_id": "forged", "lease_epoch": 999, "future_field": true}
			if operation == "" {
				delete(req, "operation")
			}
			if operation == "wrong_type" {
				req["operation"] = 42
			}
			if operation == "preview" {
				req["last_seq"] = 3
				req["payload"] = map[string]any{"text": "临时回复"}
			}
			if operation == "call_tool" {
				req["tool_call_id"] = "call-1"
				req["tool_name"] = "devices.list"
				req["arguments"] = map[string]any{}
			}
			if operation == "wait_tool" {
				req["tool_call_id"] = "exec-1"
				req["last_seq"] = 4
				req["payload"] = map[string]any{"finish_wait": true}
			}
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"id": id + 1, "request": req, "future_field": true})
			var response struct {
				Result struct {
					OK   bool   `json:"ok"`
					Code string `json:"code"`
				} `json:"result"`
			}
			if decoder.Decode(&response) != nil {
				os.Exit(3)
			}
			if (operation == "renew" || operation == "" || operation == "wrong_type") && response.Result.Code != "invalid_request" {
				os.Exit(4)
			}
		}
		return
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
