package codex

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"baton/internal/agent"
	"baton/internal/privatefile"
	"baton/internal/protocol"
)

// ReadBrowserHistory 优先只读原生文件；旧映射用独立 app-server 定位历史。
func (a *Adapter) ReadBrowserHistory(ctx context.Context, cursor string, limit int) (protocol.SessionHistoryPage, error) {
	raw, err := privatefile.ReadSnapshot(a.config.StatePath)
	var saved State
	if err != nil {
		if os.IsNotExist(err) {
			return protocol.SessionHistoryPage{}, agent.ErrHistoryMissing
		}
		return protocol.SessionHistoryPage{}, agent.ErrHistoryUnread
	}
	if json.Unmarshal(raw, &saved) != nil || !supportedVersion(saved.Version) || saved.SessionID != a.config.SessionID || saved.Directory != a.config.Directory || saved.ThreadID == "" {
		return protocol.SessionHistoryPage{}, agent.ErrHistoryMissing
	}
	if saved.HistoryPath != "" && saved.HistoryRoot != "" {
		return readHistoryFile(ctx, a.config, saved, cursor, limit)
	}
	reader := New(a.config)
	defer reader.Close()
	if err := reader.connect(ctx); err != nil {
		return protocol.SessionHistoryPage{}, agent.ErrHistoryUnread
	}
	var read struct {
		Thread struct{ ID, Cwd, Path string }
	}
	if err := reader.call(ctx, "thread/read", map[string]any{"threadId": saved.ThreadID, "includeTurns": false}, &read); err != nil {
		return protocol.SessionHistoryPage{}, agent.ErrHistoryUnread
	}
	directory, err := filepath.EvalSymlinks(read.Thread.Cwd)
	if err != nil || read.Thread.ID != saved.ThreadID || directory != a.config.Directory {
		return protocol.SessionHistoryPage{}, agent.ErrHistoryMissing
	}
	if read.Thread.Path != "" && reader.nativeHome != "" {
		saved.HistoryPath, saved.HistoryRoot = read.Thread.Path, reader.nativeHome
		return readHistoryFile(ctx, a.config, saved, cursor, limit)
	}
	reader.state = saved
	id := saved.ThreadID
	pager, err := agent.NewHistoryPager("codex:"+id, cursor, limit)
	if err != nil {
		return protocol.SessionHistoryPage{}, err
	}
	nativeCursor := ""
	for index := 0; ; {
		if err := ctx.Err(); err != nil {
			return protocol.SessionHistoryPage{}, err
		}
		page, err := reader.readHistory(ctx, nativeCursor, 1)
		if err != nil {
			return protocol.SessionHistoryPage{}, agent.ErrHistoryUnread
		}
		var entries []json.RawMessage
		if json.Unmarshal(page.Data, &entries) != nil {
			return pager.Finish("history_invalid")
		}
		for _, raw := range entries {
			more, err := pager.Add(raw, sha256.Sum256(raw), int64(len(raw)), fmt.Sprintf("codex:%s:%d", id, index))
			if err != nil {
				return protocol.SessionHistoryPage{}, err
			}
			if !more {
				return pager.Finish("")
			}
			index++
		}
		if page.NextCursor == "" {
			if index == 0 && saved.TurnID != "" {
				return protocol.SessionHistoryPage{}, agent.ErrHistoryMissing
			}
			return pager.Finish("")
		}
		if page.NextCursor == nativeCursor || len(entries) == 0 {
			return pager.Finish("history_incomplete")
		}
		nativeCursor = page.NextCursor
	}
}

func readHistoryFile(ctx context.Context, config Config, saved State, cursor string, limit int) (protocol.SessionHistoryPage, error) {
	var empty protocol.SessionHistoryPage
	rel, err := filepath.Rel(saved.HistoryRoot, saved.HistoryPath)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return empty, agent.ErrHistoryMissing
	}
	root, err := os.OpenRoot(saved.HistoryRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return empty, agent.ErrHistoryMissing
		}
		return empty, agent.ErrHistoryUnread
	}
	defer root.Close()
	f, err := agent.OpenHistoryFile(root, rel)
	if err != nil {
		if os.IsNotExist(err) {
			return empty, agent.ErrHistoryMissing
		}
		return empty, agent.ErrHistoryUnread
	}
	defer f.Close()
	return agent.ReadJSONLHistory(ctx, f, "codex:"+saved.ThreadID, cursor, limit, true, func(raw []byte) error {
		var header struct {
			Type    string
			Payload struct {
				ID, Cwd string
				Version string `json:"cli_version"`
			}
		}
		if json.Unmarshal(raw, &header) != nil || header.Type != "session_meta" || header.Payload.ID != saved.ThreadID || header.Payload.Cwd != config.Directory || header.Payload.Version != saved.Version {
			return agent.ErrHistoryMissing
		}
		return nil
	})
}
