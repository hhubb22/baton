package store

// BackgroundConcurrency 为控制面的后台查询保留有界连接份额。
func (s *Store) BackgroundConcurrency() int {
	if s == nil || s.pool == nil {
		return 4
	}
	return max(1, min(4, int(s.pool.Config().MaxConns)/2))
}
