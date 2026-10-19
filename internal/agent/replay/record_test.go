package replay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

// 子进程只按 -- 后的模式执行，测试本身不依赖 shell、cat 或 Unix 工具。
func TestRecordHelper(t *testing.T) {
	index := 0
	for i, arg := range os.Args {
		if arg == "--" {
			index = i + 1
			break
		}
	}
	if index == 0 {
		return
	}
	args := os.Args[index:]
	switch args[0] {
	case "echo":
		io.Copy(os.Stdout, os.Stdin)
		os.Stderr.Write([]byte{'e', '\r', '\n', 0xff, 0, 'x'})
		os.Exit(23)
	case "partial":
		fmt.Fprint(os.Stdout, "prefix")
		b := make([]byte, 1)
		if _, err := io.ReadFull(os.Stdin, b); err != nil {
			os.Exit(2)
		}
		fmt.Fprint(os.Stdout, "suffix\n")
		os.Exit(0)
	case "history":
		path := filepath.Join(argument(args, "--session-dir"), "history.jsonl")
		os.WriteFile(path, []byte("first\npartial"), 0600)
		fmt.Fprint(os.Stdout, "ready\n")
		b := make([]byte, 1)
		if _, err := io.ReadFull(os.Stdin, b); err != nil {
			os.Exit(2)
		}
		f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
		f.WriteString("\nsecond\n")
		f.Close()
		fmt.Fprint(os.Stdout, "done\n")
		os.Exit(0)
	}
	os.Exit(99)
}

func recordConfig(t *testing.T) RecordConfig {
	t.Helper()
	dir := t.TempDir()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	scenario := filepath.Join(dir, "scenario.json")
	data, _ := json.Marshal(Header{Agent: "pi", Protocol: "pi-rpc-jsonl", Scenario: "simple", AgentVersion: "test"})
	if err := os.WriteFile(scenario, data, 0600); err != nil {
		t.Fatal(err)
	}
	return RecordConfig{AgentBinary: binary, RawDir: filepath.Join(dir, "raw"), ScenarioFile: scenario, Bindings: map[string]string{"<workspace>": dir}}
}

func readRecording(t *testing.T, c RecordConfig) RawRecording {
	t.Helper()
	f, err := os.Open(filepath.Join(c.RawDir, "simple.raw.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	r, err := ReadRaw(f)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func helperArgs(mode string) []string { return []string{"-test.run=^TestRecordHelper$", "--", mode} }

func TestRecordBytesExitAndProcesses(t *testing.T) {
	c := recordConfig(t)
	input := []byte("one\r\nzero\x00\xff\nUnicode\u2028\u2029tail")
	for process := 1; process <= 2; process++ {
		var out, diagnostic bytes.Buffer
		exit, err := Record(context.Background(), c, helperArgs("echo"), io.NopCloser(bytes.NewReader(input)), &out, &diagnostic)
		if err != nil || exit.Code != 23 {
			t.Fatalf("退出: %+v %v", exit, err)
		}
		if !bytes.Equal(out.Bytes(), input) || !bytes.Equal(diagnostic.Bytes(), []byte{'e', '\r', '\n', 0xff, 0, 'x'}) {
			t.Fatalf("透传字节发生变化: %q %q", out.Bytes(), diagnostic.Bytes())
		}
	}
	raw := readRecording(t, c)
	for process := 1; process <= 2; process++ {
		streams := map[string][]byte{}
		var types []string
		for _, e := range raw.Entries {
			if e.Process == process {
				streams[e.Type] = append(streams[e.Type], e.Data...)
				types = append(types, e.Type)
			}
		}
		if !bytes.Equal(streams["stdin"], input) || !bytes.Equal(streams["stdout"], input) {
			t.Fatalf("原始字节: %v", streams)
		}
		if types[0] != "process_start" || types[len(types)-1] != "runtime_exit" {
			t.Fatal(types)
		}
	}
}

type observedWriter struct {
	mu      sync.Mutex
	data    []byte
	ready   chan struct{}
	once    sync.Once
	observe func([]byte)
}

func (w *observedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.data = append(w.data, p...)
	if w.observe != nil {
		w.observe(p)
	}
	w.once.Do(func() { close(w.ready) })
	return len(p), nil
}

func TestRecordPartialForwarding(t *testing.T) {
	c := recordConfig(t)
	input, writer := io.Pipe()
	out := &observedWriter{ready: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		exit, err := Record(ctx, c, helperArgs("partial"), input, out, io.Discard)
		if exit.Code != 0 {
			err = fmt.Errorf("退出: %+v %v", exit, err)
		}
		done <- err
	}()
	select {
	case <-out.ready:
	case <-ctx.Done():
		t.Fatal("无 LF 输出未即时透传")
	}
	if _, err := writer.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if string(out.data) != "prefixsuffix\n" {
		t.Fatal(string(out.data))
	}
	raw := readRecording(t, c)
	var stdout [][]byte
	for _, e := range raw.Entries {
		if e.Type == "stdout" {
			stdout = append(stdout, e.Data)
		}
	}
	if len(stdout) != 1 || string(stdout[0]) != "prefixsuffix\n" {
		t.Fatalf("分帧: %q", stdout)
	}
}

func TestRecordHistoryBeforeStdout(t *testing.T) {
	c := recordConfig(t)
	history := t.TempDir()
	input, writer := io.Pipe()
	out := &observedWriter{ready: make(chan struct{})}
	var observationErr error
	out.observe = func(p []byte) {
		file, err := os.Open(filepath.Join(c.RawDir, "simple.raw.ndjson"))
		if err != nil {
			observationErr = err
			return
		}
		raw, err := ReadRaw(file)
		file.Close()
		if err != nil {
			observationErr = err
			return
		}
		last := raw.Entries[len(raw.Entries)-1]
		if last.Type != "stdout" {
			observationErr = fmt.Errorf("转发 stdout 前未记录帧: %s", last.Type)
		}
		if len(raw.Entries) < 2 || raw.Entries[len(raw.Entries)-2].Type != "native_history" {
			observationErr = fmt.Errorf("历史未排在 stdout 前")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	args := append(helperArgs("history"), "--session-dir", history)
	go func() { _, err := Record(ctx, c, args, input, out, io.Discard); done <- err }()
	select {
	case <-out.ready:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	writer.Write([]byte("x"))
	writer.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if observationErr != nil {
		t.Fatal(observationErr)
	}
	raw := readRecording(t, c)
	var order []string
	var appends []string
	for _, e := range raw.Entries {
		if e.Type == "stdout" || e.Type == "native_history" {
			order = append(order, e.Type)
			if e.Type == "native_history" {
				appends = append(appends, string(e.Data))
			}
		}
	}
	if !reflect.DeepEqual(order, []string{"native_history", "stdout", "native_history", "stdout"}) || !reflect.DeepEqual(appends, []string{"first\n", "partial\nsecond\n"}) {
		t.Fatalf("顺序和追加: %v %q", order, appends)
	}
}

func TestLoadRecordConfigAndTemporaryOnly(t *testing.T) {
	dir := t.TempDir()
	executable := filepath.Join(dir, "recorder.exe")
	raw := `{"agent_binary":"real.exe","raw_dir":"raw","scenario_file":"scenario.json","bindings":{"<home>":"test-home"}}`
	os.WriteFile(executable+".record.json", []byte(raw), 0600)
	c, err := LoadRecordConfig(executable)
	if err != nil || c.AgentBinary != filepath.Join(dir, "real.exe") || c.RawDir != filepath.Join(dir, "raw") {
		t.Fatalf("相对配置: %+v %v", c, err)
	}
	if err := temporaryRawDir(os.TempDir()); err == nil {
		t.Fatal("允许直接写临时根目录")
	}
	repo := t.TempDir()
	os.Mkdir(filepath.Join(repo, ".git"), 0700)
	if err := temporaryRawDir(filepath.Join(repo, "raw")); err == nil {
		t.Fatal("允许写仓库内录制")
	}
}

func TestReadRawRejectsBrokenOrder(t *testing.T) {
	h := RawHeader{Type: "raw_start", Version: 1}
	for _, entries := range [][]RawEntry{
		{{Type: "stdout", Process: 1}},
		{{Type: "process_start", Process: 1, ElapsedNS: 3}, {Type: "stdout", Process: 1, ElapsedNS: 2}},
		{{Type: "process_start", Process: 1}, {Type: "runtime_exit", Process: 1}, {Type: "stdout", Process: 1}},
	} {
		var b bytes.Buffer
		d := json.NewEncoder(&b)
		d.Encode(h)
		for _, e := range entries {
			d.Encode(e)
		}
		if _, err := ReadRaw(&b); err == nil {
			t.Fatal("接受无效原始录制")
		}
	}
}

func TestRecordSharedHistoryOffsets(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "raw.ndjson")
	history := filepath.Join(dir, "history")
	os.Mkdir(history, 0700)
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.Encode(RawHeader{Type: "raw_start", Version: 1})
	enc.Encode(start(1))
	enc.Encode(start(2))
	os.WriteFile(path, b.Bytes(), 0600)
	cursor := int64(b.Len())
	r1 := recorder{path: path, process: 1, start: time.Now(), cursor: cursor, offsets: map[string]int64{}, dirs: []string{history}}
	r2 := recorder{path: path, process: 2, start: time.Now(), cursor: cursor, offsets: map[string]int64{}, dirs: []string{history}}
	os.WriteFile(filepath.Join(history, "session.jsonl"), []byte("one\n"), 0600)
	if err := r1.history(); err != nil {
		t.Fatal(err)
	}
	if err := r2.history(); err != nil {
		t.Fatal(err)
	}
	f, _ := os.OpenFile(filepath.Join(history, "session.jsonl"), os.O_APPEND|os.O_WRONLY, 0600)
	f.WriteString("two\n")
	f.Close()
	if err := r2.history(); err != nil {
		t.Fatal(err)
	}
	if err := r1.history(); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	raw, err := ReadRaw(f)
	if err != nil {
		t.Fatal(err)
	}
	var appends []string
	for _, e := range raw.Entries {
		if e.Type == "native_history" {
			appends = append(appends, string(e.Data))
		}
	}
	if !reflect.DeepEqual(appends, []string{"one\n", "two\n"}) {
		t.Fatal(appends)
	}
}

func TestRecordCallerTempRootWithIsolatedEnvironment(t *testing.T) {
	c := recordConfig(t)
	c.RawTempDir = os.TempDir()
	isolated := t.TempDir()
	for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(key, isolated)
	}
	var out, diagnostic bytes.Buffer
	exit, err := Record(context.Background(), c, helperArgs("echo"), io.NopCloser(bytes.NewReader([]byte("isolated\n"))), &out, &diagnostic)
	if err != nil || exit.Code != 23 || out.String() != "isolated\n" {
		t.Fatalf("隔离 TMPDIR 下录制失败: %+v %v", exit, err)
	}
	if _, err := os.Stat(filepath.Join(c.RawDir, "simple.raw.ndjson")); err != nil {
		t.Fatal(err)
	}
	// 显式根目录仍拒绝根目录本身、其他目录以及仓库内路径。
	if err := temporaryRawDirUnder(c.RawTempDir, c.RawTempDir); err == nil {
		t.Fatal("允许写临时根目录")
	}
	if err := temporaryRawDirUnder(c.RawDir, isolated); err == nil {
		t.Fatal("允许写配置根目录之外")
	}
	repo := filepath.Join(isolated, "repository")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := temporaryRawDirUnder(filepath.Join(repo, "raw"), isolated); err == nil {
		t.Fatal("允许写仓库内录制")
	}
}
