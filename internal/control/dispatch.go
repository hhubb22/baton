package control

import (
	"context"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"

	"github.com/coder/websocket"
)

// controlLink 是一条 Relay 控制连接。吊销回执只确认这条连接上发出的快照或补发。
type controlLink struct {
	ws    *websocket.Conn
	ready bool
	acks  map[string][]string
}

// DispatchRevocations 把尚未确认的吊销补发给当前 Relay，并等待这条连接上的回执。
// 没有控制连接时立即返回，调用方继续显示处理中。
func (s *Server) DispatchRevocations(ctx context.Context) error {
	ids, sent, err := s.pushPending(ctx)
	if err != nil || !sent {
		return err
	}
	return s.waitApplied(ctx, ids)
}

// Disconnect 关掉当前控制连接。Relay 重连后必须应用新的安全快照。
func (s *Server) Disconnect() {
	s.mu.Lock()
	link := s.link
	s.mu.Unlock()
	if link != nil && link.ws != nil {
		link.ws.Close(websocket.StatusGoingAway, "")
	}
}

func (s *Server) bind(ws *websocket.Conn) *controlLink {
	link := &controlLink{ws: ws, acks: map[string][]string{}}
	s.mu.Lock()
	s.link = link
	s.mu.Unlock()
	return link
}

func (s *Server) unbind(link *controlLink) {
	s.mu.Lock()
	if s.link == link {
		s.link = nil
	}
	s.mu.Unlock()
}

func (s *Server) markReady(link *controlLink) {
	s.mu.Lock()
	link.ready = true
	s.mu.Unlock()
}

func (s *Server) send(ctx context.Context, ws *websocket.Conn, frame protocol.Frame) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return writeFrame(ctx, ws, frame)
}

func (s *Server) completeAck(ctx context.Context, link *controlLink, id string) {
	if id == "" {
		return
	}
	s.mu.Lock()
	ids := link.acks[id]
	delete(link.acks, id)
	s.mu.Unlock()
	if len(ids) == 0 {
		return
	}
	if err := s.store.MarkRevocationsApplied(ctx, ids); err != nil {
		s.log.Error("event=revocation_apply_failed")
	}
}

func (s *Server) pushPending(ctx context.Context) ([]string, bool, error) {
	creds, nodes, ids, err := s.store.PendingRevocationSet(ctx)
	if err != nil || len(ids) == 0 {
		return nil, false, err
	}
	s.mu.Lock()
	link := s.link
	ready := link != nil && link.ready
	s.mu.Unlock()
	if !ready {
		return ids, false, nil
	}
	noticeID, err := identity.NewUUID()
	if err != nil {
		return nil, false, err
	}
	s.mu.Lock()
	current := s.link == link && link.ready
	if current {
		link.acks[noticeID] = append([]string(nil), ids...)
	}
	s.mu.Unlock()
	if !current {
		return ids, false, nil
	}
	frame := protocol.Frame{
		Kind: protocol.KindRevoke,
		Revoke: &protocol.RevokeNotice{
			ID:          noticeID,
			Credentials: creds,
			Nodes:       nodes,
		},
	}
	if err := s.send(ctx, link.ws, frame); err != nil {
		s.dropAck(link, noticeID)
		s.log.Info("event=revocation_dispatch_failed")
		return ids, false, nil
	}
	s.log.Info("event=revocation_dispatched", "revocation_id", noticeID, "credentials", len(ids))
	return ids, true, nil
}

func (s *Server) dropAck(link *controlLink, id string) {
	s.mu.Lock()
	delete(link.acks, id)
	s.mu.Unlock()
}

func (s *Server) waitApplied(ctx context.Context, credentialIDs []string) error {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		done, err := s.store.RevocationsApplied(ctx, credentialIDs)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if done {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
