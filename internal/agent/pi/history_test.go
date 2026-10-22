package pi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPiHistoryRejectsMismatchedOrEscapedFile(t *testing.T) {
	for _, broken := range []string{"id", "version", "cwd", "truncated", "escape", "symlink"} {
		t.Run(broken, func(t *testing.T) {
			a := historyAdapter(t)
			header := map[string]any{"type": "session", "id": a.config.SessionID, "version": 3, "cwd": a.config.Directory}
			switch broken {
			case "id":
				header["id"] = "another-session"
			case "version":
				header["version"] = 2
			case "cwd":
				header["cwd"] = "another-directory"
			}
			raw, _ := json.Marshal(header)
			if broken != "truncated" {
				raw = append(raw, '\n')
			}
			if err := os.WriteFile(a.history.File, raw, 0o600); err != nil {
				t.Fatal(err)
			}
			if broken == "escape" || broken == "symlink" {
				outside := filepath.Join(t.TempDir(), "outside.jsonl")
				if err := os.WriteFile(outside, raw, 0o600); err != nil {
					t.Fatal(err)
				}
				if broken == "escape" {
					a.history.File = outside
				} else {
					_ = os.Remove(a.history.File)
					if err := os.Symlink(outside, a.history.File); err != nil {
						t.Skip("symlinks unavailable")
					}
				}
				raw, _ = json.Marshal(a.history)
				if err := os.WriteFile(a.mappingPath(), raw, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			config := a.config
			config.Restore = true
			if err := New(config).Start(context.Background()); err != ErrHistoryMissing {
				t.Fatalf("accepted invalid history (%s): %v", broken, err)
			}
		})
	}
}
