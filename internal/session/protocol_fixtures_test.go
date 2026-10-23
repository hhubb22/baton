package session

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"baton/internal/protocol"
)

// TestExportWorkerProtocolFixtures 通过 Client 编码真实请求，保留 Go 的缺省字段。
func TestExportWorkerProtocolFixtures(t *testing.T) {
	const id = "12345678-1234-4234-8234-123456789abc"
	type sample struct {
		Schema string `json:"schema"`
		Name   string `json:"name"`
		Value  any    `json:"value"`
	}
	samples := []sample{}
	add := func(name string, value any) { samples = append(samples, sample{"WorkerIPCMessage", name, value}) }
	server, client := net.Pipe()
	defer client.Close()
	workerClient := &Client{conn: client, enc: json.NewEncoder(client), dec: json.NewDecoder(client)}
	go func() {
		defer server.Close()
		dec, enc := json.NewDecoder(server), json.NewEncoder(server)
		for {
			var request ipcMessage
			if dec.Decode(&request) != nil {
				return
			}
			response := ipcMessage{Type: "result", OK: true, PID: 1234, SessionID: id}
			if enc.Encode(response) != nil {
				return
			}
		}
	}()
	// 每次 roundTrip 的编码由生产 Client 完成。
	type call struct {
		name    string
		request ipcMessage
	}
	calls := []call{
		{"auth", ipcMessage{Type: "auth", Token: strings.Repeat("0", 64)}},
		{"status", ipcMessage{Type: "status"}},
		{"thread_open", ipcMessage{Type: "thread_open"}},
		{"thread_message", ipcMessage{Type: "thread_message", ClientMessageID: "input-1", Payload: "运行本地检查", Mode: "queue", Model: "gpt-6.1-sol"}},
		{"thread_withdraw", ipcMessage{Type: "thread_withdraw", ClientMessageID: "input-1"}},
		{"thread_resume", ipcMessage{Type: "thread_resume"}},
		{"thread_stop", ipcMessage{Type: "thread_stop", StopReason: "employee_stop"}},
		{"thread_pending", ipcMessage{Type: "thread_pending", AfterWorkerSeq: 1}},
		{"thread_ack", ipcMessage{Type: "thread_ack", EventID: id, WorkerSeq: 2}},
		{"session_request", ipcMessage{Type: "session_request", SessionRequest: &protocol.SessionRequest{Type: protocol.BodySessionRequest, OperationID: id, SessionID: id, Action: "output", Cursor: id + ":0"}}},
		{"native_history", ipcMessage{Type: "native_history", Payload: "native-cursor"}},
	}
	// 记录 Client 的编码字节，并同时完成往返。
	workerClient.enc = json.NewEncoder(&workerFixtureWriter{Writer: client, Record: func(raw []byte) {
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			t.Error(err)
		}
		name := calls[len(samples)].name
		add(name, value)
	}})
	for _, c := range calls {
		if _, err := workerClient.roundTrip(c.request); err != nil {
			t.Fatal(err)
		}
	}
	add("result.auth", ipcMessage{Type: "result", OK: true})
	add("result.status", ipcMessage{Type: "result", OK: true, PID: 1234, SessionID: id})
	add("result.error", ipcMessage{Type: "result", Code: "thread_rejected", Message: "尚未实现的 Thread 适配器"})
	add("result.pending", ipcMessage{Type: "result", OK: true, ThreadReports: []protocol.ThreadReport{{Type: protocol.BodyThreadReport, ThreadID: id, EventID: id, WorkerSeq: 1, Kind: "thread.opened", StorageGeneration: id, NativeSessionID: "native-session-1"}}})
	add("result.output", ipcMessage{Type: "result", OK: true, SessionResult: &protocol.SessionResult{Type: protocol.BodySessionResult, OperationID: id, SessionID: id, OK: true, State: "idle", Text: "检查通过", Cursor: id + ":12", Gap: true}})
	add("result.native_history", ipcMessage{Type: "result", OK: true, History: json.RawMessage(`{"messages":[{"role":"assistant","text":"检查通过"}]}`), HistoryCursor: "native-cursor"})
	for _, c := range calls {
		if !strings.HasPrefix(c.name, "thread_") || c.name == "thread_pending" || c.name == "thread_ack" {
			continue
		}
		modern := migrationWorkerMessage{ipcMessage: c.request, CommandID: id, ThreadID: id, StorageGeneration: "generation-1"}
		if c.name == "thread_open" {
			config := migrationOpenConfig()
			modern.OpenConfig = &config
		}
		add(c.name+".command_id", modern)
	}
	for _, ready := range []bool{false, true} {
		add(map[bool]string{false: "result.agent_starting", true: "result.agent_ready"}[ready], struct {
			ipcMessage
			WorkerReady bool `json:"worker_ready"`
			AgentReady  bool `json:"agent_ready"`
		}{ipcMessage{Type: "result", OK: true, PID: 1234, SessionID: id}, true, ready})
	}
	add("result.storage_generation", struct {
		ipcMessage
		StorageGeneration string `json:"storage_generation"`
	}{ipcMessage{Type: "result", OK: true, PID: 1234, SessionID: id}, id})
	fields := []map[string]any{}
	typ := reflect.TypeOf(ipcMessage{})
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		tag := strings.Split(f.Tag.Get("json"), ",")
		fields = append(fields, map[string]any{"name": tag[0], "optional": len(tag) > 1 && tag[1] == "omitempty", "go_type": f.Type.String()})
	}
	doc := struct {
		Source string           `json:"source"`
		Fields []map[string]any `json:"fields"`
		Cases  []sample         `json:"cases"`
	}{"internal/session/wire.go:ipcMessage", fields, samples}
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join("..", "..", "packages", "protocol", "fixtures", "go-worker.json")
	if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(target, append(raw, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
	t.Logf("导出 %d 个 IPC 变体、%d 个字段", len(samples), len(fields))
}

type workerFixtureWriter struct {
	Writer net.Conn
	Record func([]byte)
}

func (w *workerFixtureWriter) Write(raw []byte) (int, error) {
	w.Record(raw)
	return w.Writer.Write(raw)
}
