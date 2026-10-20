package node

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestWSWriterAdmissionCancellation(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		t.Run(fmt.Sprintf("timeout=%v", timeout), func(t *testing.T) {
			w := newWSWriter(nil)
			w.writeSlot <- struct{}{}
			defer func() { <-w.writeSlot }()
			ctx, cancel := context.WithCancel(context.Background())
			want := error(context.Canceled)
			if timeout {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 30*time.Millisecond)
				want = context.DeadlineExceeded
			}
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- w.write(ctx, []byte("queued")) }()
			if !timeout {
				cancel()
			}
			select {
			case err := <-done:
				if !errors.Is(err, want) {
					t.Fatalf("write returned %v, want %v", err, want)
				}
			case <-time.After(200 * time.Millisecond):
				t.Fatal("canceled sender remained queued for writer admission")
			}
			if len(w.writeSlot) != 1 {
				t.Fatal("canceled sender released another sender's admission")
			}
		})
	}
}

func TestWSWriterAlreadyCanceledDoesNotWrite(t *testing.T) {
	w := newWSWriter(nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// 取消与空槽同时就绪；任意 select 分支都不能访问 WebSocket。
	for range 100 {
		if err := w.write(ctx, []byte("canceled")); !errors.Is(err, context.Canceled) {
			t.Fatalf("already canceled write: %v", err)
		}
		if len(w.writeSlot) != 0 {
			t.Fatal("already canceled sender leaked admission")
		}
	}
}

func writerConnection(t *testing.T) (*wsWriter, <-chan string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	messages := make(chan string, 128)
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		for {
			_, raw, err := ws.Read(ctx)
			if err != nil {
				return
			}
			select {
			case messages <- string(raw):
			case <-ctx.Done():
				return
			}
		}
	}))
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		cancel()
		server.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); ws.CloseNow(); <-done; server.Close() })
	return newWSWriter(ws), messages
}

func TestWSWriterConcurrentCallersAndCanceledAdmissionPreserveConnection(t *testing.T) {
	w, messages := writerConnection(t)
	w.writeSlot <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	err := w.write(ctx, []byte("expired"))
	cancel()
	<-w.writeSlot
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("queued write: %v", err)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var writers sync.WaitGroup
	const count = 64
	writeErrors := make(chan error, count)
	for i := range count {
		writers.Add(1)
		go func() {
			defer writers.Done()
			writeErrors <- w.write(ctx, []byte(fmt.Sprintf("message-%d", i)))
		}()
	}
	writers.Wait()
	for range count {
		if err := <-writeErrors; err != nil {
			t.Fatalf("connection failed after queued cancellation: %v", err)
		}
	}
	seen := map[string]bool{}
	for range count {
		select {
		case message := <-messages:
			if seen[message] {
				t.Fatalf("duplicate message: %q", message)
			}
			seen[message] = true
		case <-ctx.Done():
			t.Fatal("concurrent messages were not delivered")
		}
	}
	for i := range count {
		if !seen[fmt.Sprintf("message-%d", i)] {
			t.Fatalf("missing message-%d: %v", i, seen)
		}
	}
	if len(w.writeSlot) != 0 {
		t.Fatal("successful writes leaked admission")
	}
}

func TestWSWriterFailureReleasesAdmission(t *testing.T) {
	w, _ := writerConnection(t)
	w.ws.CloseNow()
	for range 2 {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := w.write(ctx, []byte("closed"))
		cancel()
		if err == nil || errors.Is(err, context.DeadlineExceeded) || len(w.writeSlot) != 0 {
			t.Fatalf("failed write retained admission: err=%v slot=%d", err, len(w.writeSlot))
		}
	}
}
