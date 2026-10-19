package pi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"baton/internal/agent"
	"baton/internal/protocol"
)

func browserHistoryFixture(t *testing.T) (*Adapter, string) {
	t.Helper()
	dir := t.TempDir()
	a := New(agent.Config{SessionDir: dir, Directory: dir, SessionID: "11111111-1111-4111-8111-111111111111"})
	file := filepath.Join(dir, "history.jsonl")
	if err := a.saveMapping(file); err != nil {
		t.Fatal(err)
	}
	header, _ := json.Marshal(map[string]any{"type": "session", "id": a.config.SessionID, "version": 3, "cwd": dir})
	if err := os.WriteFile(file, append(header, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	return a, file
}

func appendHistoryLine(t *testing.T, file string, entry any) {
	t.Helper()
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(entry); err != nil {
		t.Fatal(err)
	}
}

func TestBrowserHistoryLargeBranchesAndReferences(t *testing.T) {
	a, file := browserHistoryFixture(t)
	for i := 0; i < 1000; i++ {
		text := fmt.Sprintf("条目 %d <script>坏文本</script>\u001b", i)
		if i == 17 {
			text = strings.Repeat("超大中文", 3*1024*1024)
		}
		kind := "message"
		if i == 25 {
			kind = "branch_summary"
		}
		appendHistoryLine(t, file, map[string]any{"id": fmt.Sprint(i), "parentId": fmt.Sprint(i / 2), "type": kind, "message": map[string]string{"role": "user", "content": text}})
	}
	count, truncated, cursor, pages := 0, 0, "", 0
	for {
		page, err := a.ReadBrowserHistory(context.Background(), cursor, 16)
		if err != nil {
			t.Fatal(err)
		}
		if !protocol.ValidHistoryPage(&page) {
			t.Fatal("历史页超过协议限制")
		}
		for _, entry := range page.Entries {
			if count != 17 && (entry.ID != fmt.Sprint(count) || entry.ParentID != fmt.Sprint(count/2)) {
				t.Fatal("分支关系或顺序丢失", count)
			}
			if count == 25 && entry.Kind != "branch_summary" {
				t.Fatal("分支摘要丢失")
			}
			if count == 17 && (!entry.Truncated || entry.Bytes < 32*1024*1024 || !page.Gap) {
				t.Fatal("超大单条没有引用和缺口")
			}
			if entry.Truncated {
				truncated++
			}
			if !strings.HasPrefix(entry.Reference, "pi:"+a.config.SessionID+":") || strings.Contains(entry.Text, "\x1b") {
				t.Fatal("引用或文本无效")
			}
			count++
		}
		pages++
		if page.Cursor == cursor {
			t.Fatal("游标没有前进")
		}
		cursor = page.Cursor
		if !page.HasMore {
			break
		}
	}
	if count != 1000 || truncated != 1 || pages < 63 {
		t.Fatalf("分页不完整: 条目=%d 截断=%d 页=%d", count, truncated, pages)
	}
	appendHistoryLine(t, file, map[string]string{"id": "new", "type": "message"})
	page, err := a.ReadBrowserHistory(context.Background(), cursor, 1)
	if err != nil || len(page.Entries) != 1 || page.Entries[0].ID != "new" {
		t.Fatal("末尾游标没有补取新条目", err)
	}
	t.Logf("1000 条包含一条超过 32 MiB 的原生记录，共 %d 页；页上限 %d 字节", pages, protocol.SessionHistoryBytes)
}

func TestBrowserHistoryMutationPartialAndMissing(t *testing.T) {
	a, file := browserHistoryFixture(t)
	appendHistoryLine(t, file, map[string]string{"id": "a", "type": "message"})
	appendHistoryLine(t, file, map[string]string{"id": "b", "type": "message"})
	page, err := a.ReadBrowserHistory(context.Background(), "", 1)
	if err != nil || !page.HasMore {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(file)
	if err := os.WriteFile(file, []byte(strings.Replace(string(raw), `"id":"a"`, `"id":"c"`, 1)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ReadBrowserHistory(context.Background(), page.Cursor, 1); !errors.Is(err, agent.ErrHistoryChanged) {
		t.Fatal("修改的前缀被静默接受", err)
	}
	if err := os.WriteFile(file, append(raw, []byte(`{"id":"unfinished"`)...), 0600); err != nil {
		t.Fatal(err)
	}
	partial, err := a.ReadBrowserHistory(context.Background(), "", 16)
	if err != nil || !partial.Gap || partial.Code != "history_incomplete" || len(partial.Entries) != 2 {
		t.Fatal("半行记录被视为完整", err)
	}
	if err := os.WriteFile(file, append(raw, []byte("bad-json\n")...), 0600); err != nil {
		t.Fatal(err)
	}
	broken, err := a.ReadBrowserHistory(context.Background(), "", 16)
	if err != nil || !broken.Gap || broken.Code != "history_invalid" {
		t.Fatal("损坏记录被视为完整", err)
	}
	for _, cursor := range []string{"bad", "-1:bad", "999:" + strings.Repeat("0", 64)} {
		if _, err := a.ReadBrowserHistory(context.Background(), cursor, 16); err == nil {
			t.Fatal("接受了无效游标")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := a.ReadBrowserHistory(ctx, "", 16); err == nil {
		t.Fatal("忽略了取消")
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ReadBrowserHistory(context.Background(), "", 16); !errors.Is(err, agent.ErrHistoryMissing) {
		t.Fatal("删除后未报告历史缺失", err)
	}
}
