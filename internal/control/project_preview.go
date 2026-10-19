package control

import (
	"baton/internal/projectagent"
	"time"
)

// ProjectPreview 只返回短期文本快照；调用方先检查员工归属、有效运行和历史序号。
func (s *Server) ProjectPreview(runID string, after int64) *projectagent.Preview {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.projectPreviews[runID]
	if !ok || p.AfterSeq != after || time.Since(p.UpdatedAt) > 30*time.Second {
		return nil
	}
	return &p
}

func (s *Server) saveProjectPreview(runID string, p projectagent.Preview) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.projectPreviews == nil {
		s.projectPreviews = map[string]projectagent.Preview{}
	}
	for id, v := range s.projectPreviews {
		if time.Since(v.UpdatedAt) > 30*time.Second {
			delete(s.projectPreviews, id)
		}
	}
	// 128 个快照，每个文本至多 32 KiB；慢浏览器不会积累增量队列。
	if _, ok := s.projectPreviews[runID]; !ok && len(s.projectPreviews) >= 128 {
		oldest := ""
		var at time.Time
		for id, v := range s.projectPreviews {
			if oldest == "" || v.UpdatedAt.Before(at) {
				oldest, at = id, v.UpdatedAt
			}
		}
		delete(s.projectPreviews, oldest)
	}
	p.UpdatedAt = time.Now()
	s.projectPreviews[runID] = p
}
