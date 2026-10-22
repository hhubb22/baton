package replay

import (
	"strings"
	"testing"
)

func TestNormalizeCodexNativeModelHistory(t *testing.T) {
	raw := synthetic("codex", start(1, "app-server", "--stdio"),
		rawEntry("stdin", 1, `{"id":1,"method":"thread/start","params":{}}`),
		rawEntry("stdout", 1, `{"id":1,"result":{"thread":{"id":"original-thread"}}}`),
		RawEntry{Type: "native_history", Process: 1, Path: "/test/home/sessions/rollout-original-thread.jsonl", Data: []byte(
			`{"type":"session_meta","payload":{"id":"original-thread","base_instructions":{"text":"/Users/recording-user/private instructions"}}}` + "\n" +
				`{"type":"turn_context","payload":{"model":"gpt-6.1-sol","developer_instructions":"/Users/recording-user/private","user_instructions":"recording-host","collaboration_mode":{"settings":{"developer_instructions":"/Users/recording-user/nested"}}}}` + "\n" +
				`{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"recording-user"}]}}` + "\n" +
				`{"type":"turn_context","payload":{"model":"gpt-6-luna"}}` + "\n" +
				`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"model output"}]}}` + "\n")}, finish(1))
	tape, err := Normalize(raw)
	if err != nil {
		t.Fatal(err)
	}
	all := jsonText(tape)
	for _, text := range []string{"gpt-6.1-sol", "gpt-6-luna", "model output", "thread-1"} {
		if !strings.Contains(all, text) {
			t.Fatal("原生历史事实丢失", text)
		}
	}
	for _, text := range []string{"recording-user", "recording-host", "/Users/", "original-thread"} {
		if strings.Contains(all, text) {
			t.Fatal("原生指令未规范化", text)
		}
	}
}

func TestNormalizeRetainsPiModelDirectory(t *testing.T) {
	raw := synthetic("pi",
		start(1, "--session-id", "native-session", "--session-dir", "/test/sessions"),
		rawEntry("stdin", 1, `{"id":"models","type":"get_available_models"}`),
		rawEntry("stdout", 1, `{"id":"models","type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"openai","id":"gpt-6-luna","name":"Luna","apiKey":"credential-private"}]}}`),
		finish(1))
	tape, err := Normalize(raw)
	if err != nil {
		t.Fatal(err)
	}
	all := jsonText(tape)
	if !strings.Contains(all, "get_available_models") || !strings.Contains(all, "gpt-6-luna") || strings.Contains(all, "credential-private") || strings.Contains(all, "apiKey") {
		t.Fatal("模型目录或隐私字段处理错误", all)
	}
	requests, responses := 0, 0
	for _, e := range tape.Entries {
		if e.Label == "request:get_available_models" {
			requests++
		}
		if e.Label == "response:get_available_models" {
			responses++
		}
	}
	if requests != 1 || responses != 1 || tape.Header.DroppedFrames != 0 {
		t.Fatal(requests, responses, tape.Header)
	}
}
