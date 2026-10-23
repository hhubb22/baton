package codex

import (
	"context"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sourcegraph/jsonrpc2"
)

type lifecycleWriter struct {
	err   error
	close func() error
}

func (w lifecycleWriter) Write(p []byte) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	return len(p), nil
}
func (w lifecycleWriter) Close() error { return w.close() }

type lifecycleReader struct {
	io.ReadCloser
	stopped *atomic.Int32
	t       *testing.T
}

func (r lifecycleReader) Close() error {
	if r.stopped.Load() == 0 {
		r.t.Error("关闭读管道前没有停止进程树")
	}
	return r.ReadCloser.Close()
}

func TestProtocolFailureStopsProcessTree(t *testing.T) {
	for _, scenario := range []string{"close", "eof", "invalid_frame", "write_error"} {
		t.Run(scenario, func(t *testing.T) {
			input, peer := io.Pipe()
			t.Cleanup(func() { _ = input.Close(); _ = peer.Close() })
			var stops atomic.Int32
			stopped := make(chan struct{})
			writer := lifecycleWriter{close: func() error {
				if stops.Load() == 0 {
					t.Error("关闭写管道前没有停止进程树")
				}
				return nil
			}}
			if scenario == "write_error" {
				writer.err = io.ErrClosedPipe
			}
			p := &processIO{
				ReadCloser:  lifecycleReader{ReadCloser: input, stopped: &stops, t: t},
				WriteCloser: writer,
				stopTree: func() {
					if stops.Add(1) == 1 {
						close(stopped)
					}
				},
			}
			conn := jsonrpc2.NewConn(context.Background(), jsonrpc2.NewBufferedStream(p, lineCodec{}), jsonrpc2.HandlerWithError(func(context.Context, *jsonrpc2.Conn, *jsonrpc2.Request) (any, error) { return nil, nil }), jsonrpc2.SetLogger(discardLogger{}))
			t.Cleanup(func() { _ = conn.Close(); _ = p.Close() })
			switch scenario {
			case "close":
				if err := conn.Close(); err != nil {
					t.Fatal(err)
				}
			case "eof":
				_ = peer.Close()
			case "invalid_frame":
				if _, err := io.WriteString(peer, "invalid JSON\n"); err != nil {
					t.Fatal(err)
				}
			case "write_error":
				if err := conn.Notify(context.Background(), "test", nil); !errors.Is(err, io.ErrClosedPipe) {
					t.Fatalf("写错误未保留: %v", err)
				}
			}
			select {
			case <-stopped:
			case <-time.After(3 * time.Second):
				t.Fatal("协议结束后没有停止进程树")
			}
			_ = p.Close()
			if got := stops.Load(); got != 1 {
				t.Fatalf("停止进程树 %d 次", got)
			}
		})
	}
}
