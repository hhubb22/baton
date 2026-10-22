package codex

import (
	"context"

	"encoding/json"

	"os"
	"path/filepath"
	"strings"

	"baton/internal/agent"
	"baton/internal/privatefile"
	"baton/internal/protocol"
)

// ReadBrowserHistory 只读映射对应的原生历史文件。
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
	if saved.HistoryPath == "" || saved.HistoryRoot == "" {
		return protocol.SessionHistoryPage{}, agent.ErrHistoryMissing
	}
	return readHistoryFile(ctx, a.config, saved, cursor, limit)
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
