package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"baton/internal/protocol"
)

func TestSubscriptionUsage(t *testing.T) {
	for _, args := range [][]string{
		{"login"}, {"login", "unknown"}, {"login", "openai-codex", "extra"},
		{"login", "--token", "private-input"}, {"subscriptions", "extra"},
	} {
		err := run(t.Context(), args, io.Discard, io.Discard, nil)
		var coded *exitCode
		if !errors.As(err, &coded) || coded.code != 2 || strings.Contains(err.Error(), "private-input") {
			t.Fatalf("参数 %q 没有返回安全的用法错误: %v", args, err)
		}
	}
	for _, command := range []string{"batond login", "batond subscriptions"} {
		if !strings.Contains(usage(), command) {
			t.Fatalf("帮助缺少 %s", command)
		}
	}
}

func loginFixture(t *testing.T, mode string) func(context.Context, ...string) (*exec.Cmd, error) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return func(ctx context.Context, args ...string) (*exec.Cmd, error) {
		if len(args) != 2 || args[0] != "login" {
			t.Fatalf("登录调用参数错误: %q", args)
		}
		cmd := exec.CommandContext(ctx, executable, "-test.run=^TestSubscriptionLoginHelper$", "--", mode, args[1])
		cmd.Env = append(os.Environ(), "BATON_CLI_LOGIN_HELPER=1")
		return cmd, nil
	}
}

// 测试子进程模拟交互输入、退出状态和等待取消，不访问 OAuth 服务。
func TestSubscriptionLoginHelper(t *testing.T) {
	if os.Getenv("BATON_CLI_LOGIN_HELPER") != "1" {
		return
	}
	mode, provider := os.Args[len(os.Args)-2], os.Args[len(os.Args)-1]
	if mode == "wait" {
		fmt.Fprintln(os.Stdout, "waiting")
		time.Sleep(time.Minute)
		os.Exit(9)
	}
	fmt.Fprintln(os.Stderr, "https://example.test/authorize")
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	if line != "fixture-code\n" {
		os.Exit(8)
	}
	if mode == "fail" {
		os.Exit(7)
	}
	fmt.Fprintln(os.Stdout, provider+" complete")
	os.Exit(0)
}

func TestLoginForwardsInteractiveStreams(t *testing.T) {
	for _, provider := range []string{"openai-codex", "xai"} {
		t.Run(provider, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			factory := loginFixture(t, "success")
			command := func(ctx context.Context, args ...string) (*exec.Cmd, error) {
				if !reflect.DeepEqual(args, []string{"login", provider}) {
					t.Fatalf("错误的 provider: %q", args)
				}
				return factory(ctx, args...)
			}
			if err := cmdLogin(t.Context(), []string{provider}, strings.NewReader("fixture-code\n"), &stdout, &stderr, command); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(stdout.String(), provider+" complete") || !strings.Contains(stdout.String(), "batond subscriptions") || !strings.Contains(stderr.String(), "https://example.test/authorize") {
				t.Fatalf("交互流或成功提示缺失: stdout=%q stderr=%q", stdout.String(), stderr.String())
			}
		})
	}
}

func TestLoginFailures(t *testing.T) {
	var stdout bytes.Buffer
	err := cmdLogin(t.Context(), []string{"openai-codex"}, strings.NewReader("fixture-code\n"), &stdout, io.Discard, loginFixture(t, "fail"))
	var coded *exitCode
	if !errors.As(err, &coded) || coded.code != 7 || stdout.Len() != 0 {
		t.Fatalf("未保留退出码或错误地显示成功: %v %q", err, stdout.String())
	}
	missing := errors.New("Runtime missing")
	err = cmdLogin(t.Context(), []string{"xai"}, nil, io.Discard, io.Discard, func(context.Context, ...string) (*exec.Cmd, error) { return nil, missing })
	if !errors.Is(err, missing) {
		t.Fatal("定位 Runtime 的错误被丢弃")
	}
	err = cmdLogin(t.Context(), []string{"xai"}, nil, io.Discard, io.Discard, func(ctx context.Context, _ ...string) (*exec.Cmd, error) {
		return exec.CommandContext(ctx, filepath.Join(t.TempDir(), "missing-runtime")), nil
	})
	if err == nil {
		t.Fatal("启动失败未返回错误")
	}
}

type loginReadyWriter struct{ ready chan struct{} }

func (w loginReadyWriter) Write(raw []byte) (int, error) {
	select {
	case w.ready <- struct{}{}:
	default:
	}
	return len(raw), nil
}

func TestLoginCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	ready := make(chan struct{}, 1)
	done := make(chan error, 1)
	command := loginFixture(t, "wait")
	go func() {
		done <- cmdLogin(ctx, []string{"openai-codex"}, nil, loginReadyWriter{ready}, io.Discard, command)
	}()
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("登录进程提前退出: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("登录进程未启动")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("未返回取消错误: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("取消后登录进程没有退出")
	}
}

func TestSubscriptionsShowsLocalStatus(t *testing.T) {
	var stdout bytes.Buffer
	err := cmdSubscriptions(t.Context(), nil, &stdout, func(context.Context) (*protocol.ProjectRuntime, error) {
		return &protocol.ProjectRuntime{Providers: []protocol.RuntimeProvider{
			{Provider: "openai-codex", Status: "available", Models: []protocol.RuntimeModel{{ID: "model", Name: "not-for-status-output"}}},
			{Provider: "xai", Status: "login_required"},
			{Provider: "future", Status: "unknown"},
		}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"openai-codex (ChatGPT): 已登录", "xai (xAI): 需要登录；运行 batond login xai", "future: 无法读取登录状态"} {
		if !strings.Contains(stdout.String(), text) {
			t.Fatalf("输出缺少 %q: %s", text, stdout.String())
		}
	}
	if strings.Contains(stdout.String(), "not-for-status-output") {
		t.Fatal("状态输出包含无关的模型目录")
	}
}

func TestSubscriptionsErrorsAndEmptyCatalog(t *testing.T) {
	var stdout bytes.Buffer
	missing := errors.New("Runtime missing")
	err := cmdSubscriptions(t.Context(), nil, &stdout, func(context.Context) (*protocol.ProjectRuntime, error) { return nil, missing })
	if !errors.Is(err, missing) || stdout.Len() != 0 {
		t.Fatal("探测失败仍生成状态输出")
	}
	err = cmdSubscriptions(t.Context(), nil, &stdout, func(context.Context) (*protocol.ProjectRuntime, error) { return &protocol.ProjectRuntime{}, nil })
	if err != nil || !strings.Contains(stdout.String(), "未报告订阅服务") {
		t.Fatal("空目录没有提示")
	}
}
