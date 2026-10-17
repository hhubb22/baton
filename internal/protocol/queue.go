package protocol

import "sync"

// Queue 是单连接的控制转发队列。满了就拒绝本次转发，不把未持久化的消息堆在内存里。
type Queue struct {
	mu    sync.Mutex
	items [][]byte
	bytes int
	maxN  int
	maxB  int
}

func NewQueue(maxN, maxB int) *Queue {
	if maxN < 1 {
		maxN = MaxQueueMessages
	}
	if maxB < 1 {
		maxB = MaxQueueBytes
	}
	return &Queue{maxN: maxN, maxB: maxB}
}

// Push 复制消息后入队。单条超限或队列达到条数、字节上限时返回错误，不阻塞。
func (q *Queue) Push(b []byte) error {
	if len(b) == 0 || len(b) > MaxMessageBytes {
		return ErrTooLarge
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) >= q.maxN || q.bytes+len(b) > q.maxB {
		return ErrQueueFull
	}
	cp := make([]byte, len(b))
	copy(cp, b)
	q.items = append(q.items, cp)
	q.bytes += len(b)
	return nil
}

// TryPop 取出最早的一条。队列空时返回 false。
func (q *Queue) TryPop() ([]byte, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) == 0 {
		return nil, false
	}
	item := q.items[0]
	q.items[0] = nil
	q.items = q.items[1:]
	q.bytes -= len(item)
	if len(q.items) == 0 {
		q.items = nil
	}
	return item, true
}

func (q *Queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}
