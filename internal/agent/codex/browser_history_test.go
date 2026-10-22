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
	"baton/internal/privatefile"
	"baton/internal/protocol"
)

func TestBrowserHistoryReadableAfterExit(t *testing.T) {
 for _,version:=range []string{Version,"0.162.1"} {
 t.Run(version,func(t *testing.T){testBrowserHistoryVersion(t,version)})
 }
}

func testBrowserHistoryVersion(t *testing.T,version string) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	config := Config{Directory: dir, SessionID: "history-unit", StatePath: filepath.Join(dir, "state.json")}
	state := State{Version: version, SessionID: config.SessionID, ThreadID: "thread-1", TurnID: "turn-1", Directory: dir, HistoryRoot: dir, HistoryPath: filepath.Join(dir, "history.jsonl")}
	raw, _ := json.Marshal(state)
	if err := privatefile.WriteFile(config.StatePath, raw); err != nil {
		t.Fatal(err)
	}
	header, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]string{"id": state.ThreadID, "cwd": dir, "cli_version": version}})
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
	other := Version
 if version==Version{other="0.162.1"}
	mismatch, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]string{"id": state.ThreadID, "cwd": dir, "cli_version": other}})
	if err := os.WriteFile(state.HistoryPath, append(mismatch, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ReadBrowserHistory(context.Background(), "", 16); !errors.Is(err, agent.ErrHistoryMissing) {
		t.Fatal("原生历史版本与映射不一致却被接受", err)
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
