package kiro

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
	"github.com/sourcegraph/jsonrpc2"
)

func TestQueriedDeliveryRequiresSuccessfulExecution(t *testing.T) {
	for _, name := range []string{"success", "other-id", "failed-status", "nonzero-exit", "missing-exit", "read-tool", "model-quote", "string-output", "persisted-output", "persisted-nonzero"} {
		t.Run(name, func(t *testing.T) {
			tool := map[string]any{"sessionUpdate": "tool_call", "toolCallId": "tool-1", "kind": "execute"}
			output := map[string]any{"output": `{"delivery_id":"delivery-1"}`, "exitCode": 0}
			result := map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "tool-1", "status": "completed", "rawOutput": output, "content": []any{map[string]any{"type": "content", "content": map[string]string{"type": "text", "text": "a tool result"}}}}
			switch name {
			case "other-id":
				result["toolCallId"] = "other"
			case "failed-status":
				result["status"] = "failed"
			case "nonzero-exit":
				output["exitCode"] = 1
			case "missing-exit":
				delete(output, "exitCode")
			case "read-tool":
				tool["kind"] = "read"
			case "model-quote":
				result["sessionUpdate"] = "agent_message_chunk"
			case "persisted-output":
				result["rawOutput"] = "Output:\n{\"delivery_id\":\"delivery-1\"}\n\nExit Code: 0"
			case "persisted-nonzero":
				result["rawOutput"] = "Output:\n{\"delivery_id\":\"delivery-1\"}\nExit Code: 0\n\nExit Code: 1"
			case "string-output":
				raw, _ := json.Marshal(output)
				result["rawOutput"] = string(raw)
			}
			a := New(agent.Config{})
			a.state.NativeID = "session-1"
			a.collecting = true
			for _, u := range []map[string]any{tool, result} {
				raw, _ := json.Marshal(map[string]any{"sessionId": "session-1", "update": u})
				params := json.RawMessage(raw)
				if _, err := a.handle(context.Background(), nil, &jsonrpc2.Request{Method: "session/update", Params: &params, Notif: true}); err != nil {
					t.Fatal(err)
				}
			}
			if len(a.history) != 2 {
				t.Fatal("工具结果数组被丢弃")
			}
			found, err := containsHistory(a.history, "delivery-1", true)
			if err != nil || found != (name == "success" || name == "string-output" || name == "persisted-output") {
				t.Fatal(found, err)
			}
		})
	}
}

func TestBlockedProtocolWriteHasDeadline(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	p := &processIO{ReadCloser: reader, WriteCloser: writer, writeTimeout: 20 * time.Millisecond}
	done := make(chan error, 1)
	go func() { _, err := p.Write(make([]byte, 256*1024)); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("未读管道写入成功")
		}
	case <-time.After(time.Second):
		t.Fatal("协议写入没有释放")
	}
}

type processBoundReader struct {
	io.Reader
	exited <-chan struct{}
}

func (r processBoundReader) Close() error {
	// Windows 同步管道的 Close 会等待仍在执行的 ReadFile。
	<-r.exited
	return nil
}

func TestProcessCloseKillsBeforeClosingPipe(t *testing.T) {
	if os.Getenv("BATON_TEST_KIRO_CLOSE_CHILD") == "1" {
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestProcessCloseKillsBeforeClosingPipe$")
	cmd.Env = append(os.Environ(), "BATON_TEST_KIRO_CLOSE_CHILD=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-exited })
	reader, writer := io.Pipe()
	defer reader.Close()
	p := &processIO{ReadCloser: processBoundReader{Reader: strings.NewReader(""), exited: exited}, WriteCloser: writer, cmd: cmd}
	done := make(chan struct{})
	go func() { _ = p.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("关闭管道前未终止子进程")
	}
}
