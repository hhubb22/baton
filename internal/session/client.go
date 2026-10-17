package session

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"time"
)

// StartError 是 Worker 在写入 start_intent 之前拒绝启动。
type StartError struct {
	Code    string
	Refused bool
}

func (e *StartError) Error() string {
	if e == nil || e.Code == "" {
		return "Worker 拒绝了启动"
	}
	return e.Code
}

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

// Arm 记录许可请求开始时的单调时钟，并返回重复使用的 nonce。不会启动执行器。
func (c *Client) Arm(taskID, executionID string) (Status, error) {
	return c.roundTrip(ipcMessage{Type: "arm", TaskID: taskID, ExecutionID: executionID})
}

// Authorize 把启动许可交给 Worker。许可无效时返回 StartError，并且不会启动执行器。
func (c *Client) Authorize(taskID, executionID, permit, publicKey, generation, queueExpires string) (Status, error) {
	return c.roundTrip(ipcMessage{
		Type: "authorize", TaskID: taskID, ExecutionID: executionID,
		Permit: permit, PublicKey: publicKey, StorageGeneration: generation, QueueExpiresAt: queueExpires,
	})
}

// CancelLocal 在 Session 互斥区内记录取消。已经写入 start_intent 时不会把它改成未启动。
func (c *Client) CancelLocal() (Status, error) {
	return c.roundTrip(ipcMessage{Type: "cancel_local"})
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
		if reply.Refused {
			return Status{}, &StartError{Code: reply.Code, Refused: true}
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
		Nonce:          reply.Nonce,
		Started:        reply.Started,
		Refused:        reply.Refused,
		StartIntent:    reply.StartIntent,
		Code:           reply.Code,
	}, nil
}
