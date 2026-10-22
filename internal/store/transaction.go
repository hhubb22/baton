package store

import "context"

// SetCommitHook 在 Project 或 Inbox 事务提交前运行；返回错误会回滚事务。
func (s *Store) SetCommitHook(fn func(context.Context) error) {
	s.mu.Lock()
	s.beforeCommit = fn
	s.mu.Unlock()
}

func (s *Store) runBeforeCommit(ctx context.Context) error {
	s.mu.Lock()
	fn := s.beforeCommit
	s.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx)
}
