package session

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"time"
)

// Client 是 batond 连接已有 Worker 的本地客户端。
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
	client := &Client{conn: conn, enc: json.NewEncoder(conn), dec: json.NewDecoder(conn)}
	if err := client.enc.Encode(ipcMessage{Type: "auth", Token: token}); err != nil {
		conn.Close()
		return nil, errors.New("无法认证 Worker")
	}
	var reply ipcMessage
	if err := client.dec.Decode(&reply); err != nil || !reply.OK {
		conn.Close()
		return nil, errors.New("无法认证 Worker")
	}
	return client, nil
}

func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// Bind 把执行映射交给 Worker。Worker 不会因此启动 Agent。
func (c *Client) Bind(taskID, executionID, agentType string) (Status, error) {
	return c.roundTrip(ipcMessage{Type: "bind", TaskID: taskID, ExecutionID: executionID, AgentType: agentType})
}

// Status 读取 Worker 进程和执行器计数。
func (c *Client) Status() (Status, error) {
	return c.roundTrip(ipcMessage{Type: "status"})
}

// Append 在 Session 互斥区内追加一条本地记录。
func (c *Client) Append(note string) (int64, Status, error) {
	st, err := c.roundTrip(ipcMessage{Type: "append", Note: note})
	if err != nil {
		return 0, Status{}, err
	}
	return st.Seq, st, nil
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
		if reply.Code == "session_busy" {
			return Status{}, ErrSessionBusy
		}
		if reply.Message != "" {
			return Status{}, errors.New(reply.Message)
		}
		return Status{}, errors.New("Worker 拒绝了命令")
	}
	return Status{
		PID:            reply.PID,
		SessionID:      reply.SessionID,
		ExecutorStarts: reply.ExecutorStarts,
		HookRuns:       reply.HookRuns,
		Attaches:       reply.Attaches,
		Seq:            reply.Seq,
	}, nil
}
