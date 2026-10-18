package pi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"baton/internal/agent"
	"baton/internal/privatefile"
)

var ErrHistoryMissing = agent.ErrHistoryMissing

type mapping struct {
	ID        string `json:"id"`
	File      string `json:"file"`
	Directory string `json:"directory"`
}

type message struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	StopReason string          `json:"stopReason"`
	ToolName   string          `json:"toolName"`
	IsError    bool            `json:"isError"`
}

func textContent(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var out strings.Builder
	for _, b := range blocks {
		if b.Type == "text" {
			out.WriteString(b.Text)
		}
	}
	return out.String()
}

func (a *Adapter) mappingPath() string { return filepath.Join(a.config.SessionDir, "baton-pi.json") }

func (a *Adapter) loadMapping() error {
	raw, err := privatefile.ReadFile(a.mappingPath())
	if err != nil || json.Unmarshal(raw, &a.history) != nil || a.history.ID != a.config.SessionID || a.history.Directory != a.config.Directory {
		return ErrHistoryMissing
	}
	return a.walkHistory(nil)
}

func (a *Adapter) saveMapping(file string) error {
	rel, err := filepath.Rel(a.config.SessionDir, file)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return ErrHistoryMissing
	}
	a.history = mapping{a.config.SessionID, file, a.config.Directory}
	raw, err := json.Marshal(a.history)
	if err != nil {
		return err
	}
	return privatefile.WriteFile(a.mappingPath(), raw)
}

// walkHistory streams the local file; get_entries is never forwarded to Relay.
func (a *Adapter) walkHistory(visit func(message)) error {
	rel, err := filepath.Rel(a.config.SessionDir, a.history.File)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return ErrHistoryMissing
	}
	root, err := os.OpenRoot(a.config.SessionDir)
	if err != nil {
		return ErrHistoryMissing
	}
	defer root.Close()
	f, err := root.Open(rel)
	if err != nil {
		return ErrHistoryMissing
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return ErrHistoryMissing
	}
	first := true
	err = readFrames(f, func(raw []byte) error {
		if first {
			first = false
			var h struct {
				Type    string `json:"type"`
				ID      string `json:"id"`
				Cwd     string `json:"cwd"`
				Version int    `json:"version"`
			}
			if json.Unmarshal(raw, &h) != nil || h.Type != "session" || h.ID != a.history.ID || h.Cwd != a.config.Directory || h.Version != 3 {
				return ErrHistoryMissing
			}
			return nil
		}
		var entry struct {
			Type    string  `json:"type"`
			Message message `json:"message"`
		}
		if json.Unmarshal(raw, &entry) != nil {
			return ErrHistoryMissing
		}
		if entry.Type == "message" && visit != nil {
			visit(entry.Message)
		}
		return nil
	})
	if first || err != nil {
		return ErrHistoryMissing
	}
	return nil
}

func (a *Adapter) HistoryContains(deliveryID string, queried bool) (bool, error) {
	found := false
	err := a.walkHistory(func(m message) {
		role := "user"
		if queried {
			role = "toolResult"
		}
		if m.Role != role || (queried && (m.ToolName != "bash" || m.IsError)) {
			return
		}
		for _, line := range strings.Split(textContent(m.Content), "\n") {
			var envelope struct {
				DeliveryID string `json:"delivery_id"`
			}
			if json.Unmarshal([]byte(line), &envelope) == nil && envelope.DeliveryID == deliveryID {
				found = true
			}
		}
	})
	return found, err
}
