package control

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestBackgroundDBCancellationReleasesCapacity(t *testing.T) {
	s := &Server{}
	s.backgroundOnce.Do(func() { s.background = make(chan struct{}, 1) })
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- s.backgroundDB(t.Context(), func(ctx context.Context) error {
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > backgroundTimeout {
				return errors.New("后台数据库调用缺少有限期限")
			}
			close(entered)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("后台查询未启动")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	called := false
	if err := s.backgroundDB(ctx, func(context.Context) error { called = true; return nil }); !errors.Is(err, context.Canceled) || called {
		t.Fatalf("取消后进入数据库: called=%v err=%v", called, err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := s.backgroundDB(t.Context(), func(context.Context) error { return nil }); err != nil {
		t.Fatalf("后台名额未释放: %v", err)
	}
}

func TestPeriodicMaintenanceDoesNotOverlapOrBlockOtherJobs(t *testing.T) {
	s := &Server{log: slog.New(slog.DiscardHandler)}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	entered := make(chan struct{})
	fast := make(chan struct{}, 4)
	var busy, overlap atomic.Int32
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		s.periodic(ctx, time.Millisecond, "slow", func(ctx context.Context) error {
			return s.backgroundDB(ctx, func(ctx context.Context) error {
				if busy.Add(1) != 1 {
					overlap.Add(1)
				}
				defer busy.Add(-1)
				select {
				case <-entered:
				default:
					close(entered)
				}
				<-ctx.Done()
				return ctx.Err()
			})
		})
	}()
	go func() {
		defer wg.Done()
		s.periodic(ctx, time.Millisecond, "fast", func(ctx context.Context) error {
			return s.backgroundDB(ctx, func(context.Context) error {
				select {
				case <-entered:
					select {
					case fast <- struct{}{}:
					default:
					}
				default:
				}
				return nil
			})
		})
	}()
	for range 3 {
		select {
		case <-fast:
		case <-time.After(2 * time.Second):
			t.Fatal("慢维护阻塞了其他维护项")
		}
	}
	cancel()
	wg.Wait()
	if busy.Load() != 0 || overlap.Load() != 0 {
		t.Fatalf("扫描重叠或退出后仍在运行: busy=%d overlap=%d", busy.Load(), overlap.Load())
	}
}
