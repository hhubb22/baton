package pi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"baton/internal/agent"
)

func TestMain(m *testing.M) {
	if mode := os.Getenv("BATON_PI_DIAGNOSTIC_CHILD"); mode != "" {
		diagnosticChild(mode)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// historyAdapter 只准备本地历史；这些文件边界和分页用例无需 Agent 进程。
func historyAdapter(t *testing.T) *Adapter {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := New(agent.Config{Directory: dir, SessionDir: dir, SessionID: "11111111-1111-4111-8111-111111111111"})
	a.history = mapping{ID: a.config.SessionID, File: filepath.Join(dir, "history.jsonl"), Directory: dir}
	if err := a.saveMapping(a.history.File); err != nil {
		t.Fatal(err)
	}
	header, _ := json.Marshal(map[string]any{"type": "session", "version": 3, "id": a.config.SessionID, "cwd": dir})
	if err := os.WriteFile(a.history.File, append(header, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestPiUnifiedHistoryPagination(t *testing.T) {
	a := historyAdapter(t)
	var adapter agent.Adapter = a
	f, err := os.OpenFile(a.history.File, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(f).Encode(map[string]any{"type": "session", "version": 3, "id": a.config.SessionID, "cwd": a.config.Directory}); err != nil {
		f.Close()
		t.Fatal(err)
	}
	for i := 0; i < 33; i++ {
		entry := map[string]any{"type": "message", "id": strconv.Itoa(i), "extra": "preserved", "message": map[string]any{"role": "user", "content": "message"}}
		if err := json.NewEncoder(f).Encode(entry); err != nil {
			f.Close()
			t.Fatal(err)
		}
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	count, cursor := 0, ""
	for {
		page, err := adapter.ReadHistory(context.Background(), cursor)
		if err != nil {
			t.Fatal(err)
		}
		var entries []struct{ ID, Extra string }
		if err := json.Unmarshal(page.Data, &entries); err != nil {
			t.Fatal(err)
		}
		if len(entries) > 16 {
			t.Fatal("unbounded history page")
		}
		for _, entry := range entries {
			if entry.ID != strconv.Itoa(count) || entry.Extra != "preserved" {
				t.Fatal("native entry changed", entry)
			}
			count++
		}
		if page.NextCursor == "" {
			break
		}
		if page.NextCursor == cursor {
			t.Fatal("cursor did not advance")
		}
		cursor = page.NextCursor
	}
	if count != 33 {
		t.Fatalf("lost history entries: %d", count)
	}
	if _, err := adapter.ReadHistory(context.Background(), "-1"); err == nil {
		t.Fatal("negative cursor accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := adapter.ReadHistory(ctx, ""); err == nil {
		t.Fatal("ignored cancellation")
	}
	if err := os.Remove(a.history.File); err != nil {
		t.Fatal(err)
	}
	if _, err := adapter.ReadHistory(context.Background(), ""); err == nil {
		t.Fatal("missing history silently replaced")
	}
}

func TestPiStopStatusDoesNotInferSettlementFromExit(t *testing.T) {
	a := New(agent.Config{})
	a.aborting, a.active = true, false
	a.settled = make(chan struct{})
	if stopped, known := a.StopStatus(); stopped || known {
		t.Fatal("inactive process was mistaken for settled")
	}
	a.active = true
	if err := a.consume([]byte(`{"type":"agent_settled","aborted":true}`)); err != nil {
		t.Fatal(err)
	}
	if stopped, known := a.StopStatus(); !stopped || !known {
		t.Fatal("no-tool settled stop evidence missing")
	}
}

type byteReader struct{ io.Reader }

func (r byteReader) Read(p []byte) (int, error) { return r.Reader.Read(p[:1]) }

func TestPiLFFraming(t *testing.T) {
	input := []byte("{\"s\":\"汉字\u2028\u2029\"}\r\n{\"s\":\"" + strings.Repeat("a", 300000) + "\"}\n")
	count := 0
	if err := readFrames(byteReader{bytes.NewReader(input)}, func(raw []byte) error {
		count++
		if !json.Valid(raw) {
			t.Fatal("invalid split")
		}
		return nil
	}); err != nil || count != 2 {
		t.Fatalf("framing %d %v", count, err)
	}
	if err := readFrames(strings.NewReader(`{"unterminated":true}`), func([]byte) error { return nil }); err == nil {
		t.Fatal("accepted truncated frame")
	}
}

func TestPiTextContentUnicode(t *testing.T) {
	text := "回放结果\u2028保留\u2029分隔符"
	for _, value := range []any{text, []map[string]string{{"type": "text", "text": text}}} {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if got := textContent(raw); got != text {
			t.Fatalf("Unicode 内容被改变: %q", got)
		}
	}
}

func TestPiFrameLimit(t *testing.T) {
	for _, size := range []int{9 * 1024 * 1024, maxFrame + 1} {
		input := strings.NewReader(strings.Repeat("x", size) + "\n")
		err := readFrames(input, func(raw []byte) error {
			if len(raw) != size {
				t.Fatal("大帧被截断")
			}
			return nil
		})
		if (err != nil) != (size > maxFrame) {
			t.Fatalf("帧大小 %d: %v", size, err)
		}
	}
}

func TestPiConfiguredEnvironment(t *testing.T) {
	a := New(agent.Config{ContextFile: "bound-context", Env: []string{"BATON_CONTEXT_FILE=old", "PI_OFFLINE=0", "PI_TELEMETRY=1", "CUSTOM=value"}})
	env := strings.Join(a.environment(), "\n")
	if env != "CUSTOM=value\nBATON_CONTEXT_FILE=bound-context\nPI_OFFLINE=1\nPI_TELEMETRY=0" {
		t.Fatal(env)
	}
}

func TestPiNoModelProbe(t *testing.T) {
	if os.Getenv("BATON_PI_PROBE") != "1" {
		t.Skip("explicit BATON_PI_PROBE=1 required; no model task")
	}
	dir := t.TempDir()
	bin := os.Getenv("BATON_PI_BIN")
	if bin == "" {
		bin = "pi"
	}
	a := New(agent.Config{Binary: bin, Directory: dir, SessionDir: filepath.Join(dir, "native"), SessionID: "22222222-2222-4222-8222-222222222222",
		Env: []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "USERPROFILE=" + dir, "PI_CODING_AGENT_DIR=" + filepath.Join(dir, "config")}})
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := os.Stat(a.history.File); !os.IsNotExist(err) {
		t.Fatal("no-prompt handshake unexpectedly persisted conversation")
	}
	t.Logf("version=%s platform=%s/%s model=none initialization=支持 real_tasks=未验证", Version, runtime.GOOS, runtime.GOARCH)
}
