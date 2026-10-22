package agent_test

import (
	"bufio"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"baton/internal/agent"
)

// 原生历史中的模型字段用于核对实际回合；同一断言同时检查真实录制与回放生成的文件。
func verifyNativeModelHistory(t *testing.T, c agent.Config, kind, native string, expected []string) {
	t.Helper()
	root := c.SessionDir
	if kind == "codex" {
		root = filepath.Join(c.Home, "sessions")
	}
	var models []string
	sessions := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || filepath.Ext(path) != ".jsonl" {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		s := bufio.NewScanner(f)
		s.Buffer(make([]byte, 4096), 8*1024*1024)
		for s.Scan() {
			var e struct {
				Type, ID string
				Message  struct{ Role, Model, Provider string }
				Payload  struct{ ID, Model string }
			}
			if err := json.Unmarshal(s.Bytes(), &e); err != nil {
				return err
			}
			if e.Type == "session" || e.Type == "session_meta" {
				id := e.ID
				if kind == "codex" {
					id = e.Payload.ID
				}
				if id != native {
					t.Errorf("原生历史会话 ID %q，期望 %q", id, native)
				}
				sessions++
			}
			model := ""
			if kind == "pi" && e.Type == "message" && e.Message.Role == "assistant" {
				model = e.Message.Provider + "/" + e.Message.Model
			}
			if kind == "codex" && e.Type == "turn_context" {
				model = e.Payload.Model
			}
			if model != "" && (len(models) == 0 || models[len(models)-1] != model) {
				models = append(models, model)
			}
		}
		return s.Err()
	})
	if err != nil {
		t.Fatal("读取原生模型历史", err)
	}
	if sessions != 1 || !reflect.DeepEqual(models, expected) {
		t.Fatalf("%s 原生历史会话数=%d，逐轮模型=%v，期望=%v", kind, sessions, models, expected)
	}
	t.Logf("%s 原生历史逐轮模型=%v，同一会话", kind, models)
}
