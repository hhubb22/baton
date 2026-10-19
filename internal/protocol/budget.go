package protocol

import "sync"

const MaxOutputCacheBytes = 32 * 1024 * 1024

// Budget 限制同一 Coordinator 的输出缓存，包括队列、分派与浏览器写入。
type Budget struct {
	mu          sync.Mutex
	used, limit int
}

func NewBudget(limit int) *Budget { return &Budget{limit: limit} }
func (b *Budget) Reserve(n int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if n < 0 || b.used+n > b.limit {
		return false
	}
	b.used += n
	return true
}
func (b *Budget) Release(n int) { b.mu.Lock(); b.used -= n; b.mu.Unlock() }
