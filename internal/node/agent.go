package node

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"baton/internal/agentcli"
	"baton/internal/protocol"
	"baton/internal/session"
	"baton/internal/task"
)

func (l *Ledger) ensureAgentSchema() error {
	_, err := l.db.Exec(`CREATE TABLE IF NOT EXISTS agent_contexts (
		execution_id TEXT PRIMARY KEY, token_hash BLOB NOT NULL UNIQUE,
		task_id TEXT NOT NULL, session_id TEXT NOT NULL
	)`)
	return err
}

func (l *Ledger) ensureAgentContext(report PrepareReport) error {
	if err := l.ensureAgentSchema(); err != nil {
		return err
	}
	path, err := session.AgentContextPath(l.dir, report.SessionID, report.ExecutionID)
	if err != nil {
		return err
	}
	endpoint, err := session.AgentEndpoint(l.dir)
	if err != nil {
		return err
	}
	var saved agentcli.Context
	if agentcli.ReadContext(path, &saved) == nil && saved.Endpoint == endpoint {
		binding, err := l.agentBinding(saved.Token)
		if err == nil && binding.SourceTaskID == report.TaskID && binding.SourceSessionID == report.SessionID && binding.SourceExecutionID == report.ExecutionID {
			return nil
		}
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	token := hex.EncodeToString(raw)
	hash := sha256.Sum256([]byte(token))
	if _, err := l.db.Exec(`INSERT INTO agent_contexts (execution_id, token_hash, task_id, session_id)
	 VALUES (?, ?, ?, ?) ON CONFLICT (execution_id) DO UPDATE SET token_hash = excluded.token_hash`,
		report.ExecutionID, hash[:], report.TaskID, report.SessionID); err != nil {
		return err
	}
	data, err := json.Marshal(agentcli.Context{Endpoint: endpoint, Token: token})
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".agent-*")
	if err != nil {
		return err
	}
	defer f.Close()
	defer os.Remove(f.Name())
	if _, err := f.Write(data); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func (l *Ledger) agentBinding(token string) (protocol.AgentRequest, error) {
	if len(token) != 64 {
		return protocol.AgentRequest{}, errors.New("上下文无效")
	}
	hash := sha256.Sum256([]byte(token))
	var req protocol.AgentRequest
	err := l.db.QueryRow(`SELECT task_id, session_id, execution_id FROM agent_contexts WHERE token_hash = ?`, hash[:]).Scan(
		&req.SourceTaskID, &req.SourceSessionID, &req.SourceExecutionID)
	if errors.Is(err, sql.ErrNoRows) {
		return req, errors.New("上下文无效")
	}
	return req, err
}

type agentBridge struct {
	mu   sync.Mutex
	loop *startLoop
}

func (b *agentBridge) set(loop *startLoop) {
	b.mu.Lock()
	b.loop = loop
	b.mu.Unlock()
}

func (b *agentBridge) call(ctx context.Context, req protocol.AgentRequest) protocol.AgentResult {
	b.mu.Lock()
	loop := b.loop
	b.mu.Unlock()
	if loop == nil {
		return agentFailure(task.CodeUnavailable)
	}
	body, err := json.Marshal(req)
	if err != nil {
		return agentFailure(task.CodeInvalidRequest)
	}
	raw, err := loop.roundTrip(ctx, body)
	if err != nil {
		return agentFailure(task.CodeUnavailable)
	}
	var result protocol.AgentResult
	if agentcli.Decode(raw, &result) != nil || result.Type != protocol.BodyAgentResult {
		return agentFailure(task.CodeUnavailable)
	}
	if result.OK && req.Operation == "result" && req.TaskID != req.SourceTaskID {
		var view struct {
			Ready  bool   `json:"ready"`
			Status string `json:"status"`
		}
		if json.Unmarshal(result.Data, &view) == nil && (view.Ready || view.Status == task.StatusCancelled || view.Status == task.StatusFailed || view.Status == task.StatusCompleted) {
			if err := loop.receiveChildren(ctx, &startJob{taskID: req.SourceTaskID, executionID: req.SourceExecutionID, sessionID: req.SourceSessionID}, req.TaskID, true); err != nil {
				return agentFailure(task.CodeUnavailable)
			}
			raw, err = loop.roundTrip(ctx, body)
			if err != nil || agentcli.Decode(raw, &result) != nil || result.Type != protocol.BodyAgentResult {
				return agentFailure(task.CodeUnavailable)
			}
		}
	}
	return result
}

func agentFailure(code string) protocol.AgentResult {
	return protocol.AgentResult{Type: protocol.BodyAgentResult, Code: code, Message: "操作未完成；查询或重试请沿用原 request_id"}
}

func serveAgentIPC(ctx context.Context, ledger *Ledger, bridge *agentBridge) (func(), error) {
	if err := ledger.ensureAgentSchema(); err != nil {
		return nil, err
	}
	endpoint, err := session.AgentEndpoint(ledger.dir)
	if err != nil {
		return nil, err
	}
	ln, err := session.ListenLocal(endpoint)
	if err != nil {
		return nil, errors.New("无法监听 Agent IPC")
	}
	serveCtx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	limit := make(chan struct{}, 32)
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			select {
			case limit <- struct{}{}:
				wg.Add(1)
				go func() {
					defer wg.Done()
					defer func() { <-limit }()
					serveAgentConn(serveCtx, conn, ledger, bridge)
				}()
			default:
				_ = conn.Close()
			}
		}
	}()
	return func() {
		cancel()
		_ = ln.Close()
		wg.Wait()
		_ = os.Remove(endpoint)
	}, nil
}

func serveAgentConn(ctx context.Context, conn net.Conn, ledger *Ledger, bridge *agentBridge) {
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	dec := json.NewDecoder(io.LimitReader(conn, protocol.MaxMessageBytes+1))
	dec.DisallowUnknownFields()
	var local agentcli.Request
	result := agentFailure(task.CodeInvalidRequest)
	if err := dec.Decode(&local); err == nil && dec.InputOffset() <= protocol.MaxMessageBytes {
		_ = conn.SetDeadline(time.Now().Add(32 * time.Second))
		binding, err := ledger.agentBinding(local.Token)
		if err != nil {
			result = agentFailure(task.CodeForbidden)
		} else {
			binding.Type, binding.Operation, binding.TaskID, binding.Input = protocol.BodyAgentRequest, local.Operation, local.TaskID, local.Input
			callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			_ = conn.SetDeadline(time.Now().Add(32 * time.Second))
			result = bridge.call(callCtx, binding)
			cancel()
		}
	}
	_ = json.NewEncoder(conn).Encode(result)
}
