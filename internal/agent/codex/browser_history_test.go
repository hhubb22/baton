package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/codex/replaytest"
	"baton/internal/agent/replay"
	"baton/internal/privatefile"
	"baton/internal/protocol"
)

func TestBrowserHistoryReadableAfterExit(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	config := Config{Directory: dir, SessionID: "history-unit", StatePath: filepath.Join(dir, "state.json")}
	state := State{Version: Version, SessionID: config.SessionID, ThreadID: "thread-1", TurnID: "turn-1", Directory: dir, HistoryRoot: dir, HistoryPath: filepath.Join(dir, "history.jsonl")}
	raw, _ := json.Marshal(state)
	if err := privatefile.WriteFile(config.StatePath, raw); err != nil {
		t.Fatal(err)
	}
	header, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]string{"id": state.ThreadID, "cwd": dir, "cli_version": Version}})
	body, _ := json.Marshal(map[string]any{"type": "response_item", "payload": map[string]string{"text": strings.Repeat("中文", 10000)}})
	if err := os.WriteFile(state.HistoryPath, append(append(header, '\n'), append(body, '\n')...), 0600); err != nil {
		t.Fatal(err)
	}
	a := New(config)
	a.Close()
	page, err := a.ReadBrowserHistory(context.Background(), "", 16)
	if err != nil || !protocol.ValidHistoryPage(&page) || len(page.Entries) != 2 || !page.Entries[1].Truncated || !page.Gap {
		t.Fatalf("退出后受限历史: %+v %v", page, err)
	}
	if err := os.Remove(state.HistoryPath); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ReadBrowserHistory(context.Background(), "", 16); !errors.Is(err, agent.ErrHistoryMissing) {
		t.Fatal("缺失历史", err)
	}
	if err := os.Remove(config.StatePath); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ReadBrowserHistory(context.Background(), "", 16); !errors.Is(err, agent.ErrHistoryMissing) {
		t.Fatal("缺失映射", err)
	}
}

// TestCodexHistoryNoModelProbe 验证固定 CLI 的只读跨进程查询，不发送模型输入。
func TestCodexHistoryNoModelProbe(t *testing.T) {
	if os.Getenv("BATON_CODEX_HISTORY_PROBE") != "1" {
		t.Skip("需要显式启用固定版本 Codex 无模型历史探针")
	}
	binary, err := filepath.Abs(os.Getenv("BATON_CODEX_BINARY"))
	if err != nil {
		t.Fatal(err)
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	env := []string{"HOME=" + dir, "USERPROFILE=" + dir}
	for _, key := range []string{"PATH", "SystemRoot", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP"} {
		if value := os.Getenv(key); value != "" {
			env = append(env, key+"="+value)
		}
	}
	config := Config{Binary: binary, Directory: dir, Home: dir, SessionID: "history-probe", StatePath: filepath.Join(dir, "state.json"), Env: env}
	a := New(config)
	defer a.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	var injected map[string]any
	if err := a.call(ctx, "thread/inject_items", map[string]any{"threadId": a.Snapshot().ThreadID, "items": []any{map[string]any{"type": "message", "role": "user", "content": []any{map[string]string{"type": "input_text", "text": "仅用于原生历史读取验证的样本"}}}}}, &injected); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	page, err := a.ReadBrowserHistory(ctx, "", 16)
	if err != nil || !protocol.ValidHistoryPage(&page) || len(page.Entries) == 0 {
		t.Fatalf("原连接退出后只读查询失败: err=%v entries=%d has_more=%v valid=%v", err, len(page.Entries), page.HasMore, protocol.ValidHistoryPage(&page))
	}
	saved := a.Snapshot()
	if saved.HistoryPath == "" || saved.HistoryRoot == "" {
		t.Fatal("创建时未取得原生历史位置")
	}
	f, err := os.OpenFile(saved.HistoryPath, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1000; i++ {
		text := fmt.Sprintf("后续原生样本 %d", i)
		if i == 20 {
			text = strings.Repeat("中", 4*1024*1024)
		}
		if err := json.NewEncoder(f).Encode(map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []any{map[string]string{"type": "input_text", "text": text}}}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	cursor := ""
	count, pages := 0, 0
	for {
		page, err := a.ReadBrowserHistory(ctx, cursor, 16)
		if err != nil || !protocol.ValidHistoryPage(&page) {
			t.Fatal("后续原生页不可读", err)
		}
		count += len(page.Entries)
		pages++
		cursor = page.Cursor
		if !page.HasMore {
			break
		}
	}
	if count < 1001 || pages < 63 {
		t.Fatal("原生文件分页丢失记录")
	}
	if err := os.Remove(saved.HistoryPath); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ReadBrowserHistory(ctx, cursor, 16); !errors.Is(err, agent.ErrHistoryMissing) {
		t.Fatal("原生历史删除未报告缺失", err)
	}
	t.Logf("Codex %s：无模型输入；原生文件 %d 条/%d 页，包含 12 MiB 条目，读取耗时 %s；删除被准确识别", Version, count, pages, time.Since(started))
}

// 旧映射的协议查询使用独立 app-server；录制片段只派生只读参数与大条目。
func TestBrowserHistoryFallbackReplayIsolation(t *testing.T) {
	binary := replaytest.Build(t, "../../../tools/agent-replay")
	tape := replaytest.AdapterTape(replaytest.Load(t, "testdata/replay/simple.ndjson"))
	tape, ends := replaytest.EndGates(tape)
	original := append([]replay.Entry(nil), tape.Entries...)
	for _, e := range original {
		if e.Process == 1 {
			e.Process = 3
			if e.Label != "" {
				e.Label += ":browser"
			}
			tape.Entries = append(tape.Entries, e)
		}
	}
	history := replaytest.Load(t, "testdata/replay/restore_load_only.ndjson")
	tape.Entries = append(tape.Entries, replay.Entry{Type: "process_start", Process: 4, Args: []string{"app-server", "--stdio"}})
	for _, label := range []string{"request:initialize", "response:initialize", "notification:initialized", "request:thread/read", "response:thread/read", "request:thread/items/list", "response:thread/items/list"} {
		for _, e := range history.Entries {
			if e.Label != label {
				continue
			}
			e.Process = 4
			e.Label += ":browser"
			var f map[string]any
			if err := json.Unmarshal(e.Frame, &f); err != nil {
				t.Fatal(err)
			}
			switch label {
			case "request:thread/read":
				f["params"].(map[string]any)["includeTurns"] = false
			case "response:thread/read":
				f["result"].(map[string]any)["thread"].(map[string]any)["path"] = ""
			case "request:thread/items/list":
				f["params"].(map[string]any)["limit"] = 1
			case "response:thread/items/list":
				f["result"] = map[string]any{"data": []any{map[string]any{"turnId": "turn-1", "item": map[string]string{"id": "item-browser", "type": "agentMessage", "text": strings.Repeat("中文", 10000)}}}}
			}
			e.Frame, _ = json.Marshal(f)
			tape.Entries = append(tape.Entries, e)
		}
	}
	r := replaytest.Prepare(t, binary, tape, append(ends, "event:turn/completed")...)
	config := replayConfig(r)
	a := New(config)
	defer a.Close()
	mustStart(t, a)
	mustInput(t, a)
	r.Wait(t, "event:turn/completed")
	saved := a.Snapshot()
	saved.HistoryPath = ""
	saved.HistoryRoot = ""
	raw, _ := json.Marshal(saved)
	if err := privatefile.WriteFile(config.StatePath, raw); err != nil {
		t.Fatal(err)
	}
	page, err := a.ReadBrowserHistory(context.Background(), "", 16)
	if err != nil || !protocol.ValidHistoryPage(&page) || len(page.Entries) != 1 || !page.Entries[0].Truncated {
		t.Fatal("独立协议历史查询", page, err)
	}
	r.Release(t, "event:turn/completed")
	successful(t, awaitOutput(t, a))
	r.Wait(t, ends[0])
}
