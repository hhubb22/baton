package gateway

import (
	"baton/internal/protocol"
	"sync"
)

// queue 的额度覆盖排队及已取出但尚未完成的消息。
type queue struct {
	budget                           *protocol.Budget
	closed                           bool
	mu                               sync.Mutex
	items                            [][]byte
	count, bytes, maxCount, maxBytes int
}

func newQueue(count, bytes int) *queue { return &queue{maxCount: count, maxBytes: bytes} }
func (q *queue) Push(raw []byte) error {
	if len(raw) == 0 || len(raw) > protocol.MaxMessageBytes {
		return protocol.ErrTooLarge
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return ErrUnavailable
	}
	if q.count >= q.maxCount || q.bytes+len(raw) > q.maxBytes {
		return protocol.ErrQueueFull
	}
	if q.budget != nil && !q.budget.Reserve(len(raw)) {
		return protocol.ErrQueueFull
	}
	q.count++
	q.bytes += len(raw)
	q.items = append(q.items, append([]byte(nil), raw...))
	return nil
}
func (q *queue) take() ([]byte, func(), bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) == 0 {
		return nil, func() {}, false
	}
	raw := q.items[0]
	q.items[0] = nil
	q.items = q.items[1:]
	if len(q.items) == 0 {
		q.items = nil
	}
	return raw, func() {
		q.mu.Lock()
		q.count--
		q.bytes -= len(raw)
		if q.budget != nil {
			q.budget.Release(len(raw))
		}
		q.mu.Unlock()
	}, true
}

// discard 释放断开连接后不再分派的排队消息；在途消息由原处理者释放。
func (q *queue) discard() {
	q.mu.Lock()
	q.closed = true
	defer q.mu.Unlock()
	for _, raw := range q.items {
		q.count--
		q.bytes -= len(raw)
		if q.budget != nil {
			q.budget.Release(len(raw))
		}
	}
	q.items = nil
}
