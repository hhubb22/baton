// Package agentcli 实现来源绑定的本地 CLI 客户端，不持有员工或节点连接凭据。
package agentcli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"runtime"
	"time"

	"baton/internal/protocol"
	"baton/internal/session"
	"baton/internal/task"
)

const ContextEnv = "BATON_CONTEXT_FILE"

type Context struct {
	Endpoint string `json:"endpoint"`
	Token    string `json:"token"`
}

// Request 不接受员工、来源、授权上限或节点连接凭据。
type Request struct {
	Token     string      `json:"token"`
	Operation string      `json:"operation"`
	TaskID    string      `json:"task_id,omitempty"`
	Input     *task.Input `json:"input,omitempty"`
}

func Decode(raw []byte, out any) error {
	if len(raw) > protocol.MaxMessageBytes {
		return errors.New("消息超过上限")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return errors.New("JSON 格式或字段无效")
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return errors.New("只允许一个 JSON 文档")
	}
	return nil
}

func ReadFile(path string, out any) error {
	f, err := os.Open(path)
	if err != nil {
		return errors.New("无法读取本地文件")
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, protocol.MaxMessageBytes+1))
	if err != nil {
		return errors.New("无法读取本地文件")
	}
	return Decode(raw, out)
}

func Call(ctx context.Context, path string, req Request) (protocol.AgentResult, error) {
	var local Context
	if ReadContext(path, &local) != nil {
		return protocol.AgentResult{}, errors.New("缺少有效的 BATON_CONTEXT_FILE")
	}
	req.Token = local.Token
	raw, err := json.Marshal(req)
	if err != nil || len(raw) > protocol.MaxMessageBytes {
		return protocol.AgentResult{}, errors.New("请求超过消息上限")
	}
	callCtx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	conn, err := session.DialLocal(callCtx, local.Endpoint)
	if err != nil {
		return protocol.AgentResult{}, errors.New("batond 本地 IPC 不可用")
	}
	defer conn.Close()
	deadline, _ := callCtx.Deadline()
	_ = conn.SetDeadline(deadline)
	stop := context.AfterFunc(callCtx, func() { _ = conn.Close() })
	defer stop()
	if _, err := conn.Write(append(raw, '\n')); err != nil {
		return protocol.AgentResult{}, errors.New("无法提交本地请求；重试必须沿用原 request_id")
	}
	var result protocol.AgentResult
	dec := json.NewDecoder(io.LimitReader(conn, protocol.MaxMessageBytes+1))
	if err := dec.Decode(&result); err != nil || dec.InputOffset() > protocol.MaxMessageBytes {
		return result, errors.New("无法读取响应；查询或重试必须沿用原 request_id")
	}
	if result.Type != protocol.BodyAgentResult {
		return result, errors.New("本地响应无效")
	}
	return result, nil
}

func ReadContext(path string, out *Context) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return errors.New("上下文文件不可用或权限过宽")
	}
	if ReadFile(path, out) != nil || out.Endpoint == "" || len(out.Token) != 64 {
		return errors.New("上下文文件无效")
	}
	return nil
}
