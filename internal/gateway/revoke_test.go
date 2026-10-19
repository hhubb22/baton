package gateway_test

import (
	"baton/internal/store"
	"context"
	"testing"
	"time"
)

func (p *peer) waitClosed(t *testing.T) {
	t.Helper()
	deadline := time.After(8 * time.Second)
	for {
		select {
		case _, ok := <-p.frames:
			if !ok {
				return
			}
		case <-deadline:
			t.Fatal("吊销后连接没有断开")
			return
		}
	}
}

func waitRevocation(t *testing.T, repo *store.Store, employeeID, nodeID, status string) store.RevocationView {
	t.Helper()
	deadline := time.Now().Add(12 * time.Second)
	var last store.RevocationView
	for time.Now().Before(deadline) {
		view, err := repo.NodeRevocation(context.Background(), employeeID, nodeID)
		if err == nil {
			last = view
			if view.Status == status {
				return view
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("吊销状态没有变成 %s: %+v", status, last)
	return last
}
