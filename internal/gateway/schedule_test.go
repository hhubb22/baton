package gateway

import (
	"baton/internal/protocol"
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

type heldHandler struct {
	arrived chan string
	release chan struct{}
}

func (h *heldHandler) Connected(context.Context, protocol.Source) error { return nil }
func (h *heldHandler) Disconnected(context.Context, protocol.Source)    {}
func (h *heldHandler) Heartbeat(context.Context, protocol.Source) error { return nil }
func (h *heldHandler) Handle(ctx context.Context, src protocol.Source, env protocol.Envelope) error {
	h.arrived <- src.NodeID
	select {
	case <-h.release:
	case <-ctx.Done():
	}
	return nil
}

func TestSchedulingRetainsNextNodeWhenGlobalSlotsAreFull(t *testing.T) {
	t.Parallel()
	h := &heldHandler{arrived: make(chan string, 32), release: make(chan struct{}, 32)}
	g := New(nil, h, time.Hour, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for i := 0; i < MaxHandlers+1; i++ {
		id := fmt.Sprintf("%02d", i)
		q := newQueue(32, 4096)
		raw, _ := json.Marshal(protocol.Envelope{Body: json.RawMessage(`{"type":"node.sync"}`)})
		for j := 0; j < 3; j++ {
			if err := q.Push(raw); err != nil {
				t.Fatal(err)
			}
		}
		g.nodes[id] = &slot{current: &connection{source: protocol.Source{NodeID: id}, ctx: ctx, synced: true, syncIn: newQueue(1, 4096), in: q, output: newQueue(1, 4096), last: time.Now()}}
	}
	g.schedule()
	for i := 0; i < MaxHandlers; i++ {
		select {
		case id := <-h.arrived:
			if id == "16" {
				t.Fatal("测试初始顺序不正确")
			}
		case <-time.After(time.Second):
			t.Fatal("全局处理未启动")
		}
	}
	for i := 0; i < MaxHandlers; i++ {
		h.release <- struct{}{}
	}
	deadline := time.Now().Add(time.Second)
	for len(g.jobs) > 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	g.schedule()
	seen := false
	for i := 0; i < MaxHandlers; i++ {
		select {
		case id := <-h.arrived:
			seen = seen || id == "16"
		case <-time.After(time.Second):
			t.Fatal("第二批处理未启动")
		}
	}
	if !seen {
		t.Fatal("全局并发满时跳过了下一节点")
	}
	cancel()
}

func TestOutputBudgetIncludesInFlightAndLeavesControlCapacity(t *testing.T) {
	t.Parallel()
	budget := protocol.NewBudget(64)
	a, b := newQueue(2, 64), newQueue(2, 64)
	a.budget = budget
	b.budget = budget
	if err := a.Push(make([]byte, 64)); err != nil {
		t.Fatal(err)
	}
	_, release, ok := a.take()
	if !ok {
		t.Fatal("没有取出消息")
	}
	if err := b.Push([]byte("输出")); err != protocol.ErrQueueFull {
		t.Fatal("在途输出没有占用全局额度")
	}
	control := newQueue(1, 64)
	if err := control.Push([]byte("取消")); err != nil {
		t.Fatal("输出占用了控制额度")
	}
	release()
	if err := b.Push([]byte("输出")); err != nil {
		t.Fatal(err)
	}
	b.discard()
	if !budget.Reserve(64) {
		t.Fatal("断开后未释放排队输出额度")
	}
	budget.Release(64)
}
