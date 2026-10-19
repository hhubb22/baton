package codex

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/sourcegraph/jsonrpc2"
)

// pausedResponseStream 在完整响应读出后、RPC 分发前暂停，固定缓冲响应与 Close 的顺序。
type pausedResponseStream struct {
	jsonrpc2.ObjectStream
	decoded, release, drained chan struct{}
	once                      sync.Once
}

func (s *pausedResponseStream) ReadObject(v any) error {
	err := s.ObjectStream.ReadObject(v)
	if err != nil {
		close(s.drained)
		return err
	}
	s.once.Do(func() {
		close(s.decoded)
		<-s.release
	})
	return nil
}

func waitConnectionFact(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("等待连接事实超时")
	}
}

func TestCodexCloseBeforeBufferedResponseDispatch(t *testing.T) {
	client, peer := net.Pipe()
	t.Cleanup(func() { client.Close(); peer.Close() })
	stream := &pausedResponseStream{
		ObjectStream: jsonrpc2.NewBufferedStream(client, lineCodec{}),
		decoded:      make(chan struct{}), release: make(chan struct{}), drained: make(chan struct{}),
	}
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(stream.release) }) })
	serverDone := make(chan error, 1)
	go func() {
		var req jsonrpc2.Request
		if err := json.NewDecoder(peer).Decode(&req); err != nil {
			serverDone <- err
			return
		}
		serverDone <- json.NewEncoder(peer).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"turn": map[string]string{"id": "turn-1"}}})
	}()
	a := New(Config{})
	a.conn = jsonrpc2.NewConn(context.Background(), stream, jsonrpc2.HandlerWithError(a.handle), jsonrpc2.SetLogger(discardLogger{}))
	t.Cleanup(func() { a.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	call, err := a.conn.DispatchCall(ctx, "turn/start", map[string]string{"threadId": "thread-1"})
	if err != nil {
		t.Fatal(err)
	}
	waitConnectionFact(t, stream.decoded)
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	if err := call.Wait(ctx, nil); !errors.Is(err, jsonrpc2.ErrClosed) {
		t.Fatalf("未完成 RPC 的关闭结果: %v", err)
	}
	// 迟到响应必须完成分发并继续读到 EOF，不能向关闭的等待通道写入。
	release.Do(func() { close(stream.release) })
	waitConnectionFact(t, stream.drained)
	if err := a.Close(); err != nil {
		t.Fatal("重复关闭失败", err)
	}
	if err := a.conn.Call(ctx, "turn/start", nil, nil); !errors.Is(err, jsonrpc2.ErrClosed) {
		t.Fatalf("关闭后仍接受新 RPC: %v", err)
	}
}

func TestCodexConcurrentCloseReleasesPendingCalls(t *testing.T) {
	client, peer := net.Pipe()
	t.Cleanup(func() { client.Close(); peer.Close() })
	requestsRead := make(chan struct{})
	serverDone := make(chan error, 1)
	go func() {
		decoder := json.NewDecoder(peer)
		for range 3 {
			var req jsonrpc2.Request
			if err := decoder.Decode(&req); err != nil {
				serverDone <- err
				return
			}
		}
		close(requestsRead)
		var extra jsonrpc2.Request
		serverDone <- decoder.Decode(&extra)
	}()
	a := New(Config{})
	a.conn = jsonrpc2.NewConn(context.Background(), jsonrpc2.NewBufferedStream(client, lineCodec{}), jsonrpc2.HandlerWithError(a.handle), jsonrpc2.SetLogger(discardLogger{}))
	t.Cleanup(func() { a.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var pending []jsonrpc2.Waiter
	for range 3 {
		call, err := a.conn.DispatchCall(ctx, "thread/read", map[string]string{"threadId": "thread-1"})
		if err != nil {
			t.Fatal(err)
		}
		pending = append(pending, call)
	}
	waitConnectionFact(t, requestsRead)
	var closers sync.WaitGroup
	for range 4 {
		closers.Go(func() { _ = a.Close() })
	}
	closed := make(chan struct{})
	go func() { closers.Wait(); close(closed) }()
	waitConnectionFact(t, closed)
	for _, call := range pending {
		if err := call.Wait(ctx, nil); !errors.Is(err, jsonrpc2.ErrClosed) {
			t.Fatalf("关闭未释放待决 RPC: %v", err)
		}
	}
	select {
	case err := <-serverDone:
		if !errors.Is(err, io.EOF) {
			t.Fatal("关闭后收到额外请求或连接未释放", err)
		}
	case <-ctx.Done():
		t.Fatal("关闭未释放协议 IO")
	}
}
