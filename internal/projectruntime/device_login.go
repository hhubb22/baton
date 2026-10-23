package projectruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"sync"
	"time"

	"baton/internal/protocol"
)

type deviceLoginProcess struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type deviceLoginManager struct {
	mu     sync.Mutex
	active map[string]*deviceLoginProcess
}

var deviceLogins deviceLoginManager

// StartDeviceLogin 返回设备码后继续在后台等待授权，同一服务的新登录会取消旧登录。
func StartDeviceLogin(ctx context.Context, provider string, onDone func()) (protocol.SubscriptionLoginResult, error) {
	return deviceLogins.start(ctx, provider, onDone, Command)
}

func (m *deviceLoginManager) start(ctx context.Context, provider string, onDone func(), command func(context.Context, ...string) (*exec.Cmd, error)) (protocol.SubscriptionLoginResult, error) {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "openai-codex", "chatgpt":
		provider = "openai-codex"
	case "xai":
		provider = "xai"
	default:
		return protocol.SubscriptionLoginResult{}, errors.New("不支持该模型订阅服务")
	}
	if err := ctx.Err(); err != nil {
		return protocol.SubscriptionLoginResult{}, err
	}
	loginCtx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	output := &deviceLoginOutput{result: make(chan deviceLoginNotice, 1)}
	m.mu.Lock()
	if old := m.active[provider]; old != nil {
		old.cancel()
		<-old.done
	}
	cmd, err := command(loginCtx, "login-device", provider)
	if err != nil {
		m.mu.Unlock()
		cancel()
		return protocol.SubscriptionLoginResult{}, err
	}
	cmd.Stdout = output
	cmd.WaitDelay = time.Second
	// 保持标准输入打开，Runtime 用输入关闭判断宿主是否退出。
	stdin, err := cmd.StdinPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		m.mu.Unlock()
		cancel()
		if stdin != nil {
			_ = stdin.Close()
		}
		return protocol.SubscriptionLoginResult{}, errors.New("无法启动订阅登录，请检查 Project Runtime 安装")
	}
	process := &deviceLoginProcess{cancel: cancel, done: make(chan struct{})}
	if m.active == nil {
		m.active = make(map[string]*deviceLoginProcess)
	}
	m.active[provider] = process
	m.mu.Unlock()
	go func() {
		_ = cmd.Wait()
		_ = stdin.Close()
		cancel()
		output.finish()
		close(process.done)
		m.mu.Lock()
		if m.active[provider] == process {
			delete(m.active, provider)
		}
		m.mu.Unlock()
		if onDone != nil {
			onDone()
		}
	}()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		cancel()
		return protocol.SubscriptionLoginResult{}, ctx.Err()
	case <-timer.C:
		cancel()
		return protocol.SubscriptionLoginResult{}, errors.New("等待订阅登录设备码超时")
	case notice := <-output.result:
		if notice.err != nil {
			cancel()
			return protocol.SubscriptionLoginResult{}, notice.err
		}
		result := notice.result
		result.OK, result.Provider = true, provider
		return result, nil
	}
}

type deviceLoginNotice struct {
	result protocol.SubscriptionLoginResult
	err    error
}

// deviceLoginOutput 只解析首行，限制未换行输出大小，后续输出由进程等待器持续排空。
type deviceLoginOutput struct {
	line   []byte
	sent   bool
	result chan deviceLoginNotice
}

func (o *deviceLoginOutput) Write(p []byte) (int, error) {
	n := len(p)
	if o.sent {
		return n, nil
	}
	line, _, complete := bytes.Cut(p, []byte{'\n'})
	if len(o.line)+len(line) > 16<<10 {
		o.finish()
		return n, nil
	}
	o.line = append(o.line, line...)
	if complete {
		var message struct {
			Type string `json:"type"`
			protocol.SubscriptionLoginResult
		}
		if json.Unmarshal(o.line, &message) != nil || message.Type != "device_code" || message.VerificationURI == "" || message.UserCode == "" || message.ExpiresInSeconds <= 0 {
			o.finish()
		} else {
			o.sent = true
			o.result <- deviceLoginNotice{result: message.SubscriptionLoginResult}
		}
		o.line = nil
	}
	return n, nil
}

func (o *deviceLoginOutput) finish() {
	if !o.sent {
		o.sent = true
		o.result <- deviceLoginNotice{err: errors.New("订阅登录未返回有效设备码")}
	}
}
