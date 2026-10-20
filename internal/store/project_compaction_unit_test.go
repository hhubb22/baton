package store

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"baton/internal/projectagent"
)

func TestCompactionHistoryUsesTheSameCharacterUnitsAsRuntime(t *testing.T) {
	message := func(role, text string) json.RawMessage {
		raw, _ := json.Marshal(map[string]any{"message": map[string]any{"role": role, "content": []any{map[string]string{"type": "text", "text": text}}}})
		return raw
	}
	events := []projectagent.Event{
		{Seq: 1, Kind: "input", Payload: message("user", "要求")},
		{Seq: 2, Kind: "assistant", Payload: message("assistant", strings.Repeat("x", 1000))},
		{Seq: 3, Kind: "input", Payload: message("user", "继续")},
	}
	for _, summary := range []string{strings.Repeat("中", 300), strings.Repeat("🐈", 200)} {
		p := projectagent.Compaction{ThroughSeq: 2, Summary: summary}
		if err := validateCompactionHistory(p, projectagent.Compaction{}, events); err != nil {
			t.Fatalf("有效的 Unicode 缩减被拒绝: %v", err)
		}
	}
	p := projectagent.Compaction{ThroughSeq: 2, Summary: strings.Repeat("中", 2000)}
	if err := validateCompactionHistory(p, projectagent.Compaction{}, events); !errors.Is(err, projectagent.ErrInvalid) {
		t.Fatalf("没有缩短的摘要被接受: %v", err)
	}
	if compactionUTF16Len("a中🐈") != 4 {
		t.Fatal("与 JavaScript 字符单位不一致")
	}
}
