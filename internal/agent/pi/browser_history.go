package pi

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

// ReadBrowserHistory 只读节点原生文件，Worker 退出后仍可查询，无需启动 Agent。
func (a *Adapter) ReadBrowserHistory(ctx context.Context, cursor string, limit int) (protocol.SessionHistoryPage, error) {
	var empty protocol.SessionHistoryPage
	raw, err := privatefile.ReadSnapshot(a.mappingPath())
	var m mapping
	if err != nil {
		if os.IsNotExist(err) {
			return empty, agent.ErrHistoryMissing
		}
		return empty, agent.ErrHistoryUnread
	}
	if json.Unmarshal(raw, &m) != nil || m.ID != a.config.SessionID || m.Directory != a.config.Directory {
		return empty, agent.ErrHistoryMissing
	}
	rel, err := filepath.Rel(a.config.SessionDir, m.File)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return empty, agent.ErrHistoryMissing
	}
	root, err := os.OpenRoot(a.config.SessionDir)
	if err != nil {
		return empty, agent.ErrHistoryMissing
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
	return agent.ReadJSONLHistory(ctx, f, "pi:"+m.ID, cursor, limit, false, func(raw []byte) error {
		var h struct {
			Type, ID, Cwd string
			Version       int
		}
		if json.Unmarshal(raw, &h) != nil || h.Type != "session" || h.ID != m.ID || h.Cwd != m.Directory || h.Version != 3 {
			return agent.ErrHistoryMissing
		}
		return nil
	})
}
