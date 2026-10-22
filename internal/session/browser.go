package session

import (
	"context"
	"errors"
	"unicode/utf8"

	"baton/internal/agent"
	"baton/internal/identity"
	"baton/internal/protocol"
)

type liveOutput struct {
	liveText          string
	liveBase, liveEnd int64
	liveEpoch         string
	liveGap           bool
}

func (w *liveOutput) appendLiveLocked(text string, gap bool) {
	text = agent.PlainText(text)
	w.liveText += text
	w.liveEnd += int64(len(text))
	w.liveGap = w.liveGap || gap
	if len(w.liveText) > protocol.SessionBufferBytes {
		drop := len(w.liveText) - protocol.SessionBufferBytes
		for drop < len(w.liveText) && !utf8.RuneStart(w.liveText[drop]) {
			drop++
		}
		w.liveText = w.liveText[drop:]
		w.liveBase += int64(drop)
	}
}

// BrowserRequest 只读取既有 Thread 的原生历史与实时输出。
func (h *Host) BrowserRequest(ctx context.Context, req protocol.SessionRequest) (protocol.SessionResult, error) {
	if req.Action == "history" {
		if h.historyQueries.Add(1) > 2 {
			h.historyQueries.Add(-1)
			return protocol.SessionResult{Type: protocol.BodySessionResult, OperationID: req.OperationID, SessionID: req.SessionID, Code: "history_busy"}, nil
		}
		defer h.historyQueries.Add(-1)
		if _, err := identity.ParseUUID(req.OperationID); err != nil {
			return protocol.SessionResult{}, err
		}
		if result, handled := h.storedHistory(ctx, req); handled {
			return result, nil
		}
	}
	call := func(c *Client) (Status, error) { return c.SessionRequest(req) }
	st, err := h.call(ctx, req.SessionID, call)

	if err != nil || st.SessionResult == nil {
		return protocol.SessionResult{}, errors.New("Session 暂时不可达")
	}
	return *st.SessionResult, nil
}
