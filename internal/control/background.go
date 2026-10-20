package control

import (
	"context"
	"sync"
	"time"
)

const backgroundTimeout = time.Second

// backgroundDB 的期限包含等待后台名额的时间，返回后释放数据库名额。
func (s *Server) backgroundDB(ctx context.Context, fn func(context.Context) error) error {
	s.backgroundOnce.Do(func() {
		s.background = make(chan struct{}, s.store.BackgroundConcurrency())
	})
	ctx, cancel := context.WithTimeout(ctx, backgroundTimeout)
	defer cancel()
	select {
	case s.background <- struct{}{}:
		defer func() { <-s.background }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return fn(ctx)
}

// DeliverMaintenance 独立推进各项期限与吊销补偿，单项扫描不重叠执行。
func (s *Server) DeliverMaintenance(ctx context.Context) {
	jobs := []struct {
		name string
		work func(context.Context) error
	}{
		{"execution_expire", func(ctx context.Context) error {
			return s.backgroundDB(ctx, func(ctx context.Context) error { return s.store.ExpireExecutionsAt(ctx, time.Now()) })
		}},
		{"prepare_expire", func(ctx context.Context) error {
			return s.backgroundDB(ctx, s.store.FailUnsentPrepares)
		}},
		{"queue_expire", func(ctx context.Context) error {
			return s.backgroundDB(ctx, s.store.ExpireQueuedTasks)
		}},
		{"revocation_apply", func(ctx context.Context) error {
			return s.dispatchRevocations(ctx, true)
		}},
	}
	var wg sync.WaitGroup
	for _, job := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.periodic(ctx, 200*time.Millisecond, job.name, job.work)
		}()
	}
	wg.Wait()
}

func (s *Server) periodic(ctx context.Context, interval time.Duration, name string, work func(context.Context) error) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if ctx.Err() != nil {
				return
			}
			if err := work(ctx); err != nil && ctx.Err() == nil {
				s.log.Error("event=" + name + "_failed")
			}
		}
	}
}
