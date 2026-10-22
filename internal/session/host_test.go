package session

import (
	"context"
	"errors"
	"os"
	"testing"
)

func TestCancelledWorkerSpawnDoesNotCreateSession(t *testing.T) {
	host := &Host{DataDir: t.TempDir()}
	id := mustSessionID(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := host.spawn(ctx, id); !errors.Is(err, context.Canceled) {
		t.Fatalf("取消后仍尝试启动 Worker: %v", err)
	}
	dir, err := SessionDir(host.DataDir, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("取消后创建了 Session 目录: %v", err)
	}
}
