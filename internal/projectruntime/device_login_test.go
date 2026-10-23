package projectruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestDeviceLoginProcess 使用测试进程模拟设备码返回与标准输入关闭后的退出。
func TestDeviceLoginProcess(t *testing.T) {
	if len(os.Args) < 3 || os.Args[len(os.Args)-2] != "--device-login-helper" {
		return
	}
	mode := os.Args[len(os.Args)-1]
	switch mode {
	case "valid", "completed":
		fmt.Println(`{"type":"device_code","verification_uri":"https://example.test/device","user_code":"CODE-1234","expires_in_seconds":600}`)
		if mode == "completed" {
			return
		}
	case "invalid":
		fmt.Println("无效输出")
	case "empty":
		return
	case "blocked":
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
}

func loginCommand(t *testing.T, mode string) func(context.Context, ...string) (*exec.Cmd, error) {
	t.Helper()
	return func(ctx context.Context, args ...string) (*exec.Cmd, error) {
		if len(args) != 2 || args[0] != "login-device" || args[1] != "openai-codex" && args[1] != "xai" {
			t.Errorf("错误命令: %v", args)
		}
		return exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDeviceLoginProcess$", "--", "--device-login-helper", mode), nil
	}
}

func TestDeviceLoginBackgroundAndReplacement(t *testing.T) {
	var manager deviceLoginManager
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{}, 3)
	callback := func() { done <- struct{}{} }
	result, err := manager.start(ctx, "ChatGPT", callback, loginCommand(t, "valid"))
	if err != nil || !result.OK || result.Provider != "openai-codex" || result.UserCode != "CODE-1234" || result.ExpiresInSeconds != 600 {
		t.Fatalf("设备码无效: %+v %v", result, err)
	}
	cancel()
	select {
	case <-done:
		t.Fatal("返回设备码后调用方取消中止了后台登录")
	case <-time.After(50 * time.Millisecond):
	}
	_, err = manager.start(t.Context(), "openai-codex", callback, loginCommand(t, "valid"))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("同服务旧进程未退出")
	}
	other, err := manager.start(t.Context(), "xAI", callback, loginCommand(t, "valid"))
	if err != nil || other.Provider != "xai" {
		t.Fatal(other, err)
	}
	manager.mu.Lock()
	if len(manager.active) != 2 {
		t.Errorf("不同服务相互取消: %d", len(manager.active))
	}
	for _, process := range manager.active {
		process.cancel()
	}
	manager.mu.Unlock()
	for i := 0; i < 2; i++ {
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatal("退出未触发回调")
		}
	}
}

func TestDeviceLoginCompletion(t *testing.T) {
	var manager deviceLoginManager
	done := make(chan struct{}, 1)
	result, err := manager.start(t.Context(), "chatgpt", func() { done <- struct{}{} }, loginCommand(t, "completed"))
	if err != nil || !result.OK || result.VerificationURI != "https://example.test/device" {
		t.Fatal(result, err)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("登录正常退出未触发刷新")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.active) != 0 {
		t.Fatal("登录完成后仍保留进程")
	}
}

func TestDeviceLoginRejectsInvalidOutputAndCancellation(t *testing.T) {
	for _, mode := range []string{"invalid", "empty", "blocked"} {
		t.Run(mode, func(t *testing.T) {
			var manager deviceLoginManager
			ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
			defer cancel()
			done := make(chan struct{}, 1)
			_, err := manager.start(ctx, "xai", func() { done <- struct{}{} }, loginCommand(t, mode))
			if err == nil {
				t.Fatal("无效输出或取消未被拒绝")
			}
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("失败登录未回收进程")
			}
		})
	}
	var manager deviceLoginManager
	var called atomic.Bool
	_, err := manager.start(t.Context(), "unknown", nil, func(context.Context, ...string) (*exec.Cmd, error) { called.Store(true); return nil, nil })
	if err == nil || called.Load() {
		t.Fatal("未知服务启动了进程")
	}
}

func TestDeviceLoginOutputValidation(t *testing.T) {
	for _, raw := range []string{
		"{}\n", "invalid\n", strings.Repeat("x", 17<<10),
		`{"type":"device_code","verification_uri":"https://example.test","user_code":"CODE"}` + "\n",
	} {
		output := &deviceLoginOutput{result: make(chan deviceLoginNotice, 1)}
		_, _ = output.Write([]byte(raw))
		output.finish()
		if notice := <-output.result; notice.err == nil {
			t.Fatalf("接受无效设备码: %q", raw)
		}
	}
	output := &deviceLoginOutput{result: make(chan deviceLoginNotice, 1)}
	raw, _ := json.Marshal(map[string]any{"type": "device_code", "verification_uri": "https://example.test", "user_code": "CODE", "expires_in_seconds": 900})
	for _, part := range [][]byte{raw[:10], raw[10:], []byte("\n后续诊断输出")} {
		_, _ = output.Write(part)
	}
	output.finish()
	if notice := <-output.result; notice.err != nil || notice.result.UserCode != "CODE" {
		t.Fatal(notice)
	}
}
