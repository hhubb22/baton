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

func TestPiHistoryConfirmationRequiresExactEnvelopeAndToolRole(t *testing.T) {
	a := historyAdapter(t)
	appendEntry := func(role, tool string, isError bool, payload string) {
		f, err := os.OpenFile(a.history.File, os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if err := json.NewEncoder(f).Encode(map[string]any{"type": "message", "message": map[string]any{"role": role, "toolName": tool, "isError": isError, "content": []map[string]string{{"type": "text", "text": payload}}}}); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		role, tool string
		isError    bool
		text       string
	}{
		{"user", "", false, `{"delivery_id":"prefix-delivery-1-suffix"}`},
		{"assistant", "", false, `{"delivery_id":"delivery-1"}`},
		{"toolResult", "bash", true, `{"delivery_id":"delivery-1"}`},
		{"toolResult", "read", false, `{"delivery_id":"delivery-1"}`},
		{"user", "", false, `{"summary":"delivery-1"}`},
	} {
		appendEntry(tc.role, tc.tool, tc.isError, tc.text)
	}
	for _, queried := range []bool{true, false} {
		if yes, err := a.HistoryContains("delivery-1", queried); err != nil || yes {
			t.Fatalf("false positive: %v %v", yes, err)
		}
	}
	appendEntry("toolResult", "bash", false, `{"delivery_id":"delivery-1","summary":"child result"}`)
	if yes, err := a.HistoryContains("delivery-1", true); err != nil || !yes {
		t.Fatalf("tool result missing: %v %v", yes, err)
	}
	appendEntry("user", "", false, `{"delivery_id":"delivery-1","result":{}}`)
	if yes, err := a.HistoryContains("delivery-1", false); err != nil || !yes {
		t.Fatalf("input missing: %v %v", yes, err)
	}
}
