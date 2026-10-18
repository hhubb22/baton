package relay

import (
	"baton/internal/protocol"
	"testing"
)

func TestOutputQueueLeavesControlCapacity(t *testing.T) {
	r := &Relay{haveControl: true, business: protocol.NewQueue(1, 128), outputs: protocol.NewQueue(1, 128), wake: make(chan struct{}, 1)}
	if err := r.enqueueOutput([]byte("输出")); err != nil {
		t.Fatal(err)
	}
	if err := r.enqueueOutput([]byte("更多输出")); err != protocol.ErrQueueFull {
		t.Fatal("输出超限没有拒绝")
	}
	if err := r.enqueueControl([]byte("取消任务")); err != nil {
		t.Fatal("输出占用了控制队列")
	}
	if r.business.Len() != 1 || r.outputs.Len() != 1 {
		t.Fatal("队列资源没有分别计算")
	}
}
