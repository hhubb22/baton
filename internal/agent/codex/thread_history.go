package codex

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"

	"baton/internal/agent"
	"baton/internal/privatefile"
)

// Sent reads persisted native evidence independently of the app-server connection.
func (a *Adapter) Sent(id string) (bool, error) {
	if id == "" {
		return false, nil
	}
	a.mu.Lock()
	saved := a.state
	a.mu.Unlock()
	if saved.ThreadID == "" {
		raw, err := privatefile.ReadSnapshot(a.config.StatePath)
		if err != nil {
			return false, ErrHistoryMissing
		}
		if json.Unmarshal(raw, &saved) != nil {
			return false, ErrHistoryMissing
		}
	}
	if saved.ThreadID == "" || saved.SessionID != a.config.SessionID || saved.Directory != a.config.Directory || !supportedVersion(saved.Version) || saved.HistoryRoot == "" || saved.HistoryPath == "" {
		return false, ErrHistoryMissing
	}
	rel, err := filepath.Rel(saved.HistoryRoot, saved.HistoryPath)
	if err != nil || !filepath.IsAbs(saved.HistoryRoot) || !filepath.IsAbs(saved.HistoryPath) || !filepath.IsLocal(rel) {
		return false, ErrHistoryMissing
	}
	root, err := os.OpenRoot(saved.HistoryRoot)
	if err != nil {
		return false, err
	}
	defer root.Close()
	f, err := agent.OpenHistoryFile(root, rel)
	if err != nil {
		return false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return false, err
	}
	// Bound the scan to the current file size even while Codex keeps appending.
	r := bufio.NewReader(io.LimitReader(f, info.Size()))
	var header struct {
		Type    string
		Payload struct {
			ID, Cwd string
			Version string `json:"cli_version"`
		}
	}
	line, err := readNativeLine(r)
	if err != nil || json.Unmarshal(line, &header) != nil || header.Type != "session_meta" || header.Payload.ID != saved.ThreadID || header.Payload.Cwd != saved.Directory || header.Payload.Version != saved.Version {
		return false, ErrHistoryMissing
	}
	for {
		line, err := readNativeLine(r)
		if err == io.EOF {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		var record struct {
			Type    string
			Payload struct {
				Type, Role                string
				ClientUserMessageID       string `json:"clientUserMessageId"`
				NativeClientUserMessageID string `json:"client_user_message_id"`
				ClientID                  string `json:"clientId"`
			}
		}
		if json.Unmarshal(line, &record) != nil {
			return false, ErrUncertain
		}
		p := record.Payload
		user := record.Type == "response_item" && p.Type == "message" && p.Role == "user" || record.Type == "event_msg" && p.Type == "user_message"
		if user && (p.ClientUserMessageID == id || p.NativeClientUserMessageID == id || p.ClientID == id) {
			return true, nil
		}
	}
}

func readNativeLine(r *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		part, err := r.ReadSlice('\n')
		if len(line)+len(part) > maxFrame {
			return nil, ErrUncertain
		}
		line = append(line, part...)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err == io.EOF && len(line) != 0 {
			return nil, ErrUncertain
		}
		if err != nil {
			return nil, err
		}
		return []byte(strings.TrimSpace(string(line))), nil
	}
}
