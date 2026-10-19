// 本程序用真实本地 IPC 验证 Runtime 传输和进程生命周期，不访问模型。
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"baton/internal/session"
)

type command struct {
	ID      string         `json:"id"`
	RunID   string         `json:"run_id"`
	Request map[string]any `json:"request"`
}

type record struct {
	ID       string          `json:"id"`
	RunID    string          `json:"run_id"`
	PID      int             `json:"pid"`
	Response json.RawMessage `json:"response,omitempty"`
	Error    string          `json:"error,omitempty"`
}

var logMu sync.Mutex

func writeRecord(r record) {
	logMu.Lock()
	defer logMu.Unlock()
	f, err := os.OpenFile(os.Getenv("BATON_TEST_PROJECT_RUNTIME_LOG"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(r); err != nil {
		panic(err)
	}
}

func main() {
	if len(os.Args) != 2 {
		os.Exit(2)
	}
	if os.Args[1] == "probe" {
		fmt.Print(`{"version":"0.1.0","providers":[{"provider":"openai-codex","status":"available"}]}`)
		return
	}
	if os.Args[1] != "run" {
		os.Exit(2)
	}
	runID := os.Getenv("BATON_PROJECT_RUN_ID")
	writeRecord(record{ID: "start", RunID: runID, PID: os.Getpid()})
	seen := map[string]bool{}
	for {
		f, err := os.Open(os.Getenv("BATON_TEST_PROJECT_RUNTIME_COMMANDS"))
		if err == nil {
			scanner := bufio.NewScanner(f)
			scanner.Buffer(make([]byte, 4096), 192<<10)
			for scanner.Scan() {
				var c command
				if json.Unmarshal(scanner.Bytes(), &c) != nil || c.RunID != runID || seen[c.ID] {
					continue
				}
				seen[c.ID] = true
				go execute(c, runID)
			}
			f.Close()
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func execute(c command, runID string) {
	r := record{ID: c.ID, RunID: runID, PID: os.Getpid()}
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	conn, err := session.DialLocal(ctx, os.Getenv("BATON_PROJECT_RUNTIME_ENDPOINT"))
	if err == nil {
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(35 * time.Second))
		err = json.NewEncoder(conn).Encode(map[string]any{"token": os.Getenv("BATON_PROJECT_RUNTIME_TOKEN"), "request": c.Request})
		if err == nil {
			err = json.NewDecoder(conn).Decode(&r.Response)
		}
	}
	if err != nil {
		r.Error = err.Error()
	}
	writeRecord(r)
}
