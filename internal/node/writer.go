package node

import (
	"context"
	"github.com/coder/websocket"
)

type wsWriter struct {
	sessionSlots chan struct{}
	ws           *websocket.Conn
	writeSlot    chan struct{}
}

func newWSWriter(ws *websocket.Conn) *wsWriter {
	return &wsWriter{ws: ws, sessionSlots: make(chan struct{}, 16), writeSlot: make(chan struct{}, 1)}
}

func (w *wsWriter) write(ctx context.Context, payload []byte) error {
	select {
	case w.writeSlot <- struct{}{}:
		defer func() { <-w.writeSlot }()
	case <-ctx.Done():
		return ctx.Err()
	}
	// 空槽与取消可能同时就绪，取得槽后仍须先核对取消状态。
	if err := ctx.Err(); err != nil {
		return err
	}
	return w.ws.Write(ctx, websocket.MessageText, payload)
}
