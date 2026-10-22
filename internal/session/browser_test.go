package session

import (
	"context"
	"strings"
	"testing"
	"unicode/utf8"

	"baton/internal/protocol"
)

func TestBrowserOutputBoundedAndGap(t *testing.T) {
	w := newThreadTestWorker(t, nil, &threadFake{})
	w.live.appendLiveLocked(strings.Repeat("中文", 100000), false)
	if len(w.live.liveText) > protocol.SessionBufferBytes || !utf8.ValidString(w.live.liveText) {
		t.Fatal("输出缓存超限或截断 UTF-8")
	}
	req := protocol.SessionRequest{SessionID: w.options.ThreadID, OperationID: mustSessionID(t), Action: "output"}
	result := w.SessionRequest(context.Background(), req)
	if !result.OK || !result.Gap || len(result.Text) > protocol.SessionOutputBytes || !utf8.ValidString(result.Text) {
		t.Fatalf("输出页无效: %+v", result)
	}
	req.Cursor = result.Cursor
	next := w.SessionRequest(context.Background(), req)
	if !next.OK || next.Gap || next.Cursor == result.Cursor {
		t.Fatal("有效游标没有继续输出")
	}
	req.Cursor = mustSessionID(t) + ":0"
	if got := w.SessionRequest(context.Background(), req); !got.Gap {
		t.Fatal("Worker 代次变化没有报告缺口")
	}
	req.Cursor = "bad"
	if got := w.SessionRequest(context.Background(), req); got.OK || got.Code != "invalid_cursor" {
		t.Fatal("接受了无效游标")
	}
}
