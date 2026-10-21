package kiro

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	"baton/internal/agent"
	"github.com/sourcegraph/jsonrpc2"
)

func TestThreadHistoryUserMessages(t *testing.T) {
	entry := func(kind, id, text string) json.RawMessage {
		raw, _ := json.Marshal(map[string]any{"update": map[string]any{"sessionUpdate": kind, "content": map[string]string{"type": "text", "text": text}, "_meta": map[string]any{"kiro": map[string]string{"messageId": id}}}})
		return raw
	}
	entries := []json.RawMessage{
		entry("user_message_chunk", "first", "same "), entry("user_message_chunk", "first", "text"),
		entry("agent_message_chunk", "assistant", "reply"), entry("user_message_chunk", "second", "same text"),
		entry("user_message_chunk", "third", "another message"),
		json.RawMessage(`{"update":{"sessionUpdate":"tool_call_update","content":[{"type":"content"}]}}`),
	}
	users, err := historyUsers(entries)
	if err != nil || len(users) != 3 || users[0] != "same text" || users[1] != "same text" || users[2] != "another message" {
		t.Fatal(users, err)
	}
	if _, err := historyUsers([]json.RawMessage{json.RawMessage(`{`)}); !errors.Is(err, agent.ErrHistoryUnread) {
		t.Fatal(err)
	}
	if _, err := historyUsers([]json.RawMessage{json.RawMessage(`{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"image"}}}`)}); !errors.Is(err, agent.ErrHistoryUnread) {
		t.Fatal(err)
	}
	a := New(agent.Config{})
	defer a.Close()
	if sent, err := a.Sent("unrecorded"); sent || !errors.Is(err, agent.ErrHistoryUnread) {
		t.Fatal(sent, err)
	}
	a.RestoreIntent("negative", "text", -1)
	if sent, err := a.Sent("negative"); sent || !errors.Is(err, agent.ErrHistoryUnread) {
		t.Fatal(sent, err)
	}
}

func TestThreadRepliesFlushAtToolBoundaries(t *testing.T) {
	a := New(agent.Config{})
	defer a.Close()
	a.state.NativeID = "native"
	a.active, a.threadMode = true, true
	a.threadMessageID = "message"
	update := func(kind, text string) {
		raw, _ := json.Marshal(map[string]any{"sessionId": "native", "update": map[string]any{"sessionUpdate": kind, "content": map[string]string{"type": "text", "text": text}}})
		params := json.RawMessage(raw)
		if _, err := a.handle(context.Background(), nil, &jsonrpc2.Request{Method: "session/update", Notif: true, Params: &params}); err != nil {
			t.Fatal(err)
		}
	}
	update("agent_message_chunk", "before ")
	update("agent_message_chunk", "tool")
	update("tool_call", "")
	update("tool_call_update", "")
	update("agent_message_chunk", "between tools")
	update("tool_call", "")
	update("agent_message_chunk", "after tools")
	a.mu.Lock()
	a.flushReplyLocked()
	a.mu.Unlock()
	events := a.DrainEvents()
	want := []string{"before tool", "between tools", "after tools"}
	if len(events) != len(want) {
		t.Fatal(events)
	}
	for i, e := range events {
		if e.Kind != agent.EventReply || e.Content != want[i] || e.ClientMessageID != "message" || e.NativeSessionID != "native" {
			t.Fatal(e)
		}
	}
	if len(a.DrainEvents()) != 0 {
		t.Fatal("reply emitted twice")
	}
}

func TestThreadReplyTruncatesAtUTF8Boundaries(t *testing.T) {
	text := strings.Repeat("世", 30000)
	var b replyBuffer
	for offset := 0; offset < len(text); offset += 777 {
		b.append(text[offset:min(offset+777, len(text))])
	}
	out := b.text()
	if b.total != int64(len(text)) || len(out) > 32*1024 || !utf8.ValidString(out) || !strings.HasPrefix(text, out[:len(out)/2]) || !strings.HasSuffix(text, out[len(out)/2:]) {
		t.Fatal(len(out), b.total)
	}
}
