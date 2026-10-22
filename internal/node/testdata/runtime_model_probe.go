//go:build ignore

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	binary, _ := os.Executable()
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(binary), "config.json"))
	if err != nil {
		panic(err)
	}
	var config struct {
		Agent, Log string
		Failure    bool
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		panic(err)
	}
	kind := config.Agent
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(map[string]string{"pi": "1.3.0", "codex": "codex-cli 0.163.0", "kiro": "kiro-cli 2.32.0"}[kind])
		return
	}
	cwd, _ := os.Getwd()
	log, err := os.OpenFile(config.Log, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		panic(err)
	}
	defer log.Close()
	record := func(method string) {
		_ = json.NewEncoder(log).Encode(map[string]string{"method": method, "cwd": cwd, "home": os.Getenv("HOME"), "codex_home": os.Getenv("CODEX_HOME")})
	}
	record("start")
	scanner, out := bufio.NewScanner(os.Stdin), json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Type   string          `json:"type"`
			Params struct {
				Meta struct {
					Kiro struct{ ModelID string } `json:"kiro"`
				} `json:"_meta"`
			} `json:"params"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(2)
		}
		method := request.Method
		if kind == "pi" {
			method = request.Type
		}
		record(method)
		if method == "initialized" {
			continue
		}
		var result any = map[string]any{}
		switch method {
		case "initialize":
			if kind == "codex" {
				result = map[string]any{"userAgent": "model-probe", "codexHome": cwd}
			} else {
				result = map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{
					"loadSession": true, "sessionCapabilities": map[string]any{"list": map[string]any{}},
					"_meta": map[string]any{"kiro": map[string]any{"extensionMethods": []string{"_kiro/session/history"}}},
				}}
			}
		case "set_auto_retry":
		case "get_state":
			args := map[string]string{}
			for i := 1; i+1 < len(os.Args); i++ {
				args[os.Args[i]] = os.Args[i+1]
			}
			provider, model := "provider", "model-a"
			if configured := args["--model"]; configured != "" {
				provider, model, _ = strings.Cut(configured, "/")
			}
			result = map[string]any{"sessionId": args["--session-id"], "sessionFile": filepath.Join(args["--session-dir"], "probe.jsonl"), "model": map[string]string{"provider": provider, "id": model}}
		case "get_available_models":
			result = map[string]any{"models": []any{map[string]string{"id": "model-a", "provider": "provider", "name": "Model A"}}}
		case "model/list":
			result = map[string]any{"data": []any{map[string]any{"id": "model-a", "model": "model-a", "displayName": "Model A", "isDefault": true}}}
		case "session/new":
			model := request.Params.Meta.Kiro.ModelID
			if model == "" {
				model = "model-a"
			}
			result = map[string]any{"sessionId": "temporary-session", "models": map[string]any{"currentModelId": model, "availableModels": []any{map[string]string{"modelId": "model-a", "name": "Model A"}}}}
		default:
			os.Exit(3)
		}
		fail := config.Failure && (method == "get_available_models" || method == "model/list" || method == "session/new")
		if kind == "pi" {
			_ = out.Encode(map[string]any{"id": request.ID, "type": "response", "command": method, "success": !fail, "data": result})
		} else if fail {
			_ = out.Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "error": map[string]any{"code": -32603, "message": "private diagnostic"}})
		} else {
			_ = out.Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
		}
	}
}
