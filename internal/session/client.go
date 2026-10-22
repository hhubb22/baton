package session

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"time"

	"baton/internal/protocol"
)

// Client 是 batond 连接已有 Thread Worker 的本地客户端。
type Client struct {
	conn net.Conn
	enc  *json.Encoder
	dec  *json.Decoder
}

// Dial 完成认证并返回一条已认证的连接。
func Dial(ctx context.Context, endpoint, token string) (*Client, error) {
	conn, err := dialEndpoint(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(3 * time.Second)
	}
	_ = conn.SetDeadline(deadline)
	c := &Client{conn: conn, enc: json.NewEncoder(conn), dec: json.NewDecoder(conn)}
	if err := c.enc.Encode(ipcMessage{Type: "auth", Token: token}); err != nil {
		conn.Close()
		return nil, errors.New("无法认证 Worker")
	}
	var reply ipcMessage
	if err := c.dec.Decode(&reply); err != nil || !reply.OK {
		conn.Close()
		return nil, errors.New("无法认证 Worker")
	}
	return c, nil
}
func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}
func (c *Client) Status() (Status, error) { return c.roundTrip(ipcMessage{Type: "status"}) }

// NativeHistory 读取设备本地的原生历史。
func (c *Client) NativeHistory(cursor string) (json.RawMessage, string, error) {
	st, err := c.roundTrip(ipcMessage{Type: "native_history", Payload: cursor})
	return st.History, st.HistoryCursor, err
}
func (c *Client) SessionRequest(req protocol.SessionRequest) (Status, error) {
	return c.roundTrip(ipcMessage{Type: "session_request", SessionRequest: &req})
}
func (c *Client) roundTrip(msg ipcMessage) (Status, error) {
	if err := c.enc.Encode(msg); err != nil {
		return Status{}, errors.New("无法写入 Worker")
	}
	var reply ipcMessage
	if err := c.dec.Decode(&reply); err != nil {
		return Status{}, errors.New("无法读取 Worker")
	}
	if !reply.OK {
		if reply.Code == "thread_rejected" {
			return Status{}, &ThreadCommandError{Message: reply.Message}
		}
		if reply.Message != "" {
			return Status{}, errors.New(reply.Message)
		}
		return Status{}, errors.New("Worker 拒绝了命令")
	}
	return Status{ThreadReports: reply.ThreadReports, SessionResult: reply.SessionResult, History: reply.History, HistoryCursor: reply.HistoryCursor, PID: reply.PID, SessionID: reply.SessionID}, nil
}
