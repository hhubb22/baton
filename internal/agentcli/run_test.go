package agentcli

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/identity"
	"baton/internal/privatefile"
	"baton/internal/privatefiletest"
	"baton/internal/protocol"
	"baton/internal/session"
	"baton/internal/task"
)

func TestStrictRequestAndWaitFlags(t *testing.T) {
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{}, {"task", "get", id}, {"task", "wait", id, "--json", "--timeout", "0s"},
		{"task", "wait", id, "--json", "--timeout", "6m"}, {"task", "get", id, "--json", "--timeout", "1s"},
		{"task", "get", id, "--json", "extra"}, {"task", "get", "not-a-uuid", "--json"},
	} {
		if _, _, err := parse(args); err == nil {
			t.Fatalf("接受无效参数: %v", args)
		}
	}
	for _, raw := range []string{`{"employee_id":"forged"}`, `{} {}`, `{"request_id":"same","description":"x","source_execution_id":"forged"}`} {
		if err := Decode([]byte(raw), new(task.Input)); err == nil {
			t.Fatal("接受未声明字段或多文档")
		}
	}
}

func TestContextRejectsInsecureFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "context.json")
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(Context{Endpoint: "local", Token: hex.EncodeToString(token)})
	if err != nil {
		t.Fatal(err)
	}
	if err := privatefile.WriteFile(path, raw); err != nil {
		t.Fatal(err)
	}
	if err := ReadContext(path, new(Context)); err != nil {
		t.Fatal(err)
	}
	privatefiletest.MakePublic(t, path)
	if err := ReadContext(path, new(Context)); err == nil {
		t.Fatal("接受了权限过宽的上下文")
	}
	if err := privatefile.WriteFile(path, raw); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(filepath.Dir(path), "link.json")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if err := ReadContext(link, new(Context)); err == nil {
		t.Fatal("接受了符号链接上下文")
	}
}

func TestWaitOnlyReadsAndHonorsDeadline(t *testing.T) {
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	for _, changes := range []bool{false, true} {
		t.Run(map[bool]string{false: "timeout", true: "change"}[changes], func(t *testing.T) {
			dir := t.TempDir()
			endpoint, err := session.AgentEndpoint(dir)
			if err != nil {
				t.Fatal(err)
			}
			ln, err := session.ListenLocal(endpoint)
			if err != nil {
				t.Fatal(err)
			}
			defer ln.Close()
			defer os.Remove(endpoint)
			token := make([]byte, 32)
			if _, err := rand.Read(token); err != nil {
				t.Fatal(err)
			}
			local := Context{Endpoint: endpoint, Token: hex.EncodeToString(token)}
			raw, err := json.Marshal(local)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "context.json")
			if err := privatefile.WriteFile(path, raw); err != nil {
				t.Fatal(err)
			}
			var reads, writes atomic.Int64
			done := make(chan struct{})
			defer func() { ln.Close(); <-done }()
			go func() {
				defer close(done)
				for {
					conn, err := ln.Accept()
					if err != nil {
						return
					}
					func(conn net.Conn) {
						defer conn.Close()
						var req Request
						if json.NewDecoder(conn).Decode(&req) != nil {
							return
						}
						if req.Operation != "get" || req.Token != local.Token || req.TaskID != id {
							writes.Add(1)
						}
						version := 1
						if n := reads.Add(1); changes && n > 1 {
							version = 2
						}
						data, _ := json.Marshal(task.Record{TaskID: id, Status: task.StatusQueued, Version: version})
						_ = json.NewEncoder(conn).Encode(protocol.AgentResult{Type: protocol.BodyAgentResult, OK: true, Data: data})
					}(conn)
				}
			}()
			var out bytes.Buffer
			start := time.Now()
			if err := Run(context.Background(), []string{"task", "wait", id, "--timeout", "450ms", "--json"}, &out, func(string) string { return path }); err != nil {
				t.Fatal(err)
			}
			var result struct {
				TimedOut bool        `json:"timed_out"`
				Waiting  bool        `json:"waiting"`
				Task     task.Record `json:"task"`
			}
			if err := json.Unmarshal(out.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.TimedOut == changes || !result.Waiting || writes.Load() != 0 || reads.Load() < 2 || time.Since(start) > 2*time.Second {
				t.Fatalf("等待改变任务或超时错误: %+v", result)
			}
			if changes && result.Task.Version != 2 {
				t.Fatal("未观察到版本变化")
			}
		})
	}
}
