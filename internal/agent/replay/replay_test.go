package replay

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func raw(s string) json.RawMessage { return json.RawMessage(s) }

func minimal(entries ...Entry) Transcript {
	return Transcript{Header: Header{Type: "transcript_start", Source: "handwritten-test", Protocol: "jsonrpc"}, Entries: entries}
}

func TestTranscriptRoundTrip(t *testing.T) {
	source := `{"type":"transcript_start","agent":"test","protocol":"jsonrpc","source":"handwritten-test"}
{"type":"process_start","process":1,"args":[]}
{"type":"emit_inbound","process":1,"label":"version","frame": { "text": "test 1" }}
{"type":"runtime_exit","process":1,"code":0}
{"type":"process_start","process":2,"args":["rpc"]}
{"type":"expect_outbound","process":2,"label":"request:go","frame":{"id":"<$request>","method":"go"}}
{"type":"emit_inbound","process":2,"label":"response:go","frame":{"id":"<$request>","result":{}}}
{"type":"emit_stderr","process":2,"text":"diagnostic"}
{"type":"native_history","process":2,"path":"<home>/session","append":"line\n"}
{"type":"runtime_exit","process":2,"code":7,"signal":"SIGTERM"}
`
	first, err := Read(strings.NewReader(source))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := Write(&buf, first); err != nil {
		t.Fatal(err)
	}
	second, err := Read(&buf)
	if err != nil || !reflect.DeepEqual(first, second) {
		t.Fatalf("往返不一致: %v\n%+v\n%+v", err, first, second)
	}
	for _, bad := range []string{"", `{"type":"process_start","process":1}`, `{"type":"transcript_start"}` + "\n" + `{"type":"emit_inbound","process":1,"frame":{}}`, source + `{"type":"unknown","process":3}`} {
		if _, err := Read(strings.NewReader(bad)); err == nil {
			t.Fatalf("接受了无效转录 %q", bad)
		}
	}
}

func TestStructuralComparisonAndExpansion(t *testing.T) {
	bindings := map[string]string{"<workspace>": `C:\temp\work "quoted"`, "<home>": "<workspace>"}
	captures := map[string]any{}
	actual, _ := json.Marshal(map[string]any{"id": json.Number("9007199254740993"), "params": []any{bindings["<workspace>"], true, "session:runtime-id"}})
	if err := Match(raw(`{"params":["<workspace>","<any>","session:<$session>"],"id":"<$request>"}`), actual, bindings, captures); err != nil {
		t.Fatal(err)
	}
	expanded, err := Expand(raw(`{"id":"<$request>","text":"<$session>","path":"<workspace>","<workspace>":"<home>"}`), bindings, captures)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := decode(expanded)
	m := v.(map[string]any)
	if m["id"] != json.Number("9007199254740993") || m["text"] != "runtime-id" || m["path"] != bindings["<workspace>"] || m["<workspace>"] != "<workspace>" {
		t.Fatal(string(expanded))
	}
	for _, pair := range [][2]string{
		{`{"x":1}`, `{"x":1,"extra":2}`}, {`{"x":1}`, `{"y":1}`},
		{`[1,2]`, `[2,1]`}, {`"thread-1"`, `"thread-2"`}, {`"<$request>"`, `"9007199254740993"`},
		{`"<missing>"`, `"anything"`}, {`"x:<$same>:<$same>"`, `"x:a:b"`},
	} {
		if err := Match(raw(pair[0]), raw(pair[1]), bindings, captures); err == nil {
			t.Errorf("未拒绝 %v", pair)
		}
	}
	before := len(captures)
	if err := Match(raw(`{"a":"<$new>","z":1}`), raw(`{"a":"new","z":2}`), nil, captures); err == nil || len(captures) != before {
		t.Fatal("失败比较留下了部分捕获")
	}
	if _, err := Expand(raw(`"<$missing>"`), nil, captures); err == nil {
		t.Fatal("未拒绝未知捕获")
	}
}

func TestJSONRPCIDOwnership(t *testing.T) {
	for _, tc := range []struct {
		direction, frame string
		valid            bool
	}{
		{"expect_outbound", `{"id":"<$id>","method":"start"}`, true},
		{"emit_inbound", `{"id":"<$id>","result":{}}`, true},
		{"emit_inbound", `{"id":"approval-1","method":"approve"}`, true},
		{"expect_outbound", `{"id":"approval-1","result":{}}`, true},
		{"expect_outbound", `{"id":"<any>","method":"start"}`, false},
		{"expect_outbound", `{"id":1,"method":"start"}`, false},
		{"emit_inbound", `{"id":"<$id>","method":"approve"}`, false},
		{"expect_outbound", `{"id":"<$id>","result":{}}`, false},
	} {
		tape := minimal(Entry{Type: "process_start", Process: 1}, Entry{Type: tc.direction, Process: 1, Frame: raw(tc.frame)})
		if err := tape.Validate(); (err == nil) != tc.valid {
			t.Errorf("%s %s: %v", tc.direction, tc.frame, err)
		}
	}
}

func configFor(t *testing.T, tape Transcript) Config {
	t.Helper()
	dir := t.TempDir()
	var buf bytes.Buffer
	if err := Write(&buf, tape); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "tape.ndjson")
	if err := os.WriteFile(path, buf.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	return Config{Transcript: path, StateDir: filepath.Join(dir, "state")}
}

func TestGatesAndNativeHistoryOrder(t *testing.T) {
	tape := minimal(
		Entry{Type: "process_start", Process: 1},
		Entry{Type: "native_history", Process: 1, Path: "<history>", Append: `{"cwd":"<workspace>"}` + "\n"},
		Entry{Type: "emit_inbound", Process: 1, Label: "event:turn/started", Frame: raw(`{"ok":true}`)},
		Entry{Type: "runtime_exit", Process: 1},
	)
	c := configFor(t, tape)
	history := filepath.Join(t.TempDir(), "history.jsonl")
	c.Bindings = map[string]string{"<history>": history, "<workspace>": `C:\temp\work`}
	c.Gates = []string{"event:turn/started"}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, readEnd := io.Pipe()
	defer out.Close()
	defer readEnd.Close()
	done := make(chan error, 1)
	go func() { _, err := Serve(ctx, c, nil, strings.NewReader(""), readEnd, io.Discard); done <- err }()
	if err := WaitReached(ctx, c.StateDir, c.Gates[0]); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(history)
	if err != nil {
		t.Fatal(err)
	}
	var h map[string]string
	if err := json.Unmarshal(data, &h); err != nil || h["cwd"] != c.Bindings["<workspace>"] {
		t.Fatalf("历史转义: %s %v", data, err)
	}
	select {
	case err := <-done:
		t.Fatalf("门前退出: %v", err)
	default:
	}
	// 管道尚无读者；回放只能在 release 之后向它写事件。
	if err := Release(c.StateDir, c.Gates[0]); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil || line != "{\"ok\":true}\n" {
		t.Fatalf("事件: %s %v", line, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestDerivedVariants(t *testing.T) {
	base := minimal(Entry{Type: "process_start", Process: 1}, Entry{Type: "emit_inbound", Process: 1, Label: "a", Frame: raw(`{"a":1}`)}, Entry{Type: "emit_inbound", Process: 1, Label: "settled", Frame: raw(`{"done":true}`)}, Entry{Type: "runtime_exit", Process: 1})
	cut, err := base.CutAfter("a")
	if err != nil {
		t.Fatal(err)
	}
	drop, err := base.Drop("settled")
	if err != nil {
		t.Fatal(err)
	}
	// 替换为协议允许的失败值，覆盖真实模型无法按需触发的错误分支。
	replaced, err := base.Replace("a", raw(`{"error":"quota"}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		tape   Transcript
		output string
		signal string
	}{
		{cut, "{\"a\":1}\n", "SIGKILL"}, {drop, "{\"a\":1}\n", ""}, {replaced, "{\"error\":\"quota\"}\n{\"done\":true}\n", ""},
	} {
		c := configFor(t, tc.tape)
		var output bytes.Buffer
		exit, err := Serve(context.Background(), c, nil, strings.NewReader(""), &output, io.Discard)
		if err != nil || output.String() != tc.output || exit.Signal != tc.signal {
			t.Fatalf("派生结果: %q %+v %v", output.String(), exit, err)
		}
	}
	if len(base.Entries) != 4 || string(base.Entries[1].Frame) != `{"a":1}` {
		t.Fatal("派生修改了原转录")
	}
	if _, err := base.Drop("missing"); err == nil {
		t.Fatal("缺失 label 未报错")
	}
	if _, err := base.Replace("settled", raw(`bad`)); err == nil {
		t.Fatal("接受无效 JSON")
	}
	base.Entries[0].Label = "process"
	if _, err := base.Drop("process"); err == nil {
		t.Fatal("删掉了非入站帧")
	}
}

func TestConcurrentProcessClaims(t *testing.T) {
	tape := minimal(
		Entry{Type: "process_start", Process: 1, Args: []string{"first"}},
		Entry{Type: "expect_outbound", Process: 1, Frame: raw(`{"id":"<$request>","method":"start"}`)},
		Entry{Type: "emit_inbound", Process: 1, Label: "captured", Frame: raw(`{"id":"<$request>","result":{}}`)},
		Entry{Type: "expect_outbound", Process: 1, Frame: raw(`{"method":"finish"}`)},
		Entry{Type: "runtime_exit", Process: 1},
		Entry{Type: "process_start", Process: 2, Args: []string{"second"}},
		Entry{Type: "emit_inbound", Process: 2, Frame: raw(`{"id":"<$request>","result":{}}`)},
		Entry{Type: "runtime_exit", Process: 2},
	)
	c := configFor(t, tape)
	c.Gates = []string{"captured"}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	input, writer := io.Pipe()
	defer input.Close()
	defer writer.Close()
	done := make(chan error, 1)
	go func() { _, err := Serve(ctx, c, []string{"first"}, input, io.Discard, io.Discard); done <- err }()
	if _, err := io.WriteString(writer, "{\"id\":73,\"method\":\"start\"}\n"); err != nil {
		t.Fatal(err)
	}
	if err := WaitReached(ctx, c.StateDir, "captured"); err != nil {
		t.Fatal(err)
	}
	// 第一个进程停在门前，第二个仍可领取编号并读取已持久化的捕获。
	var output bytes.Buffer
	exit, err := Serve(ctx, c, []string{"second"}, strings.NewReader(""), &output, io.Discard)
	if err != nil || exit.Code != 0 || !strings.Contains(output.String(), `"id":73`) {
		t.Fatalf("并行进程: %+v %v %s", exit, err, output.String())
	}
	if err := Release(c.StateDir, "captured"); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(writer, "{\"method\":\"finish\"}\n"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestLFFraming(t *testing.T) {
	value := `{"value":"first` + "\u2028" + `second` + "\u2029" + `last"}`
	tape := minimal(Entry{Type: "process_start", Process: 1}, Entry{Type: "expect_outbound", Process: 1, Frame: raw(value)}, Entry{Type: "emit_inbound", Process: 1, Frame: raw(value)}, Entry{Type: "runtime_exit", Process: 1})
	c := configFor(t, tape)
	var output bytes.Buffer
	exit, err := Serve(context.Background(), c, nil, strings.NewReader(value+"\r\n"), &output, io.Discard)
	if err != nil || exit.Code != 0 {
		t.Fatalf("LF 分帧: %+v %v", exit, err)
	}
	if err := Match(raw(value), output.Bytes(), nil, nil); err != nil {
		t.Fatal(err)
	}
}

func TestUndeclaredTagsStayLiteral(t *testing.T) {
	bindings := map[string]string{"<workspace>": `C:\w`}
	raw, err := Expand([]byte(`{"text":"<tools>\n- read</tools> in <workspace>"}`), bindings, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]string
	if err := json.Unmarshal(raw, &got); err != nil || got["text"] != "<tools>\n- read</tools> in C:\\w" {
		t.Fatalf("got %s, %v", raw, err)
	}
	if err := Match([]byte(`"<rules> at <workspace>"`), []byte(`"<rules> at C:\\w"`), bindings, map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if err := Match([]byte(`"<rules>"`), []byte(`"other"`), bindings, map[string]any{}); err == nil {
		t.Fatal("未声明的标签应按原文比较")
	}
	if _, err := declaredBindings(Header{Bindings: []string{"<home>"}}, bindings); err == nil {
		t.Fatal("缺少声明的绑定时应失败")
	}
	got2, err := declaredBindings(Header{Bindings: []string{"<workspace>"}}, map[string]string{"<workspace>": "/w", "<tools>": "x"})
	if err != nil || len(got2) != 1 {
		t.Fatalf("只应保留声明的绑定: %v %v", got2, err)
	}
}
