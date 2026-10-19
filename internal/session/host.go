package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"sync/atomic"
	"time"
)

// Host 由 batond 用来启动或重新连接 Session Worker。
type Host struct {
	DataDir        string
	Logger         *slog.Logger
	historyQueries atomic.Int32
}

// Reconnect 在 batond 启动时连回仍然存活的 Worker，不新开执行。
func (h *Host) Reconnect(ctx context.Context, sessionIDs []string) {
	for _, id := range sessionIDs {
		st, err := h.call(ctx, id, func(c *Client) (Status, error) {
			return c.Status()
		})
		if err != nil {
			if recErr := h.Reconcile(ctx, id); recErr != nil && h.Logger != nil {
				if errors.Is(recErr, ErrHistoryMissing) || errors.Is(recErr, ErrHistoryIncompatible) {
					h.Logger.Info("event=history_unreadable", "session_id", id, "reason", recErr.Error())
				} else {
					h.Logger.Info("event=history_read_failed", "session_id", id, "reason", recErr.Error())
				}
				continue
			}
			if h.Logger != nil {
				h.Logger.Info("event=worker_pid_not_proof", "session_id", id)
			}
			continue
		}
		if h.Logger != nil {
			h.Logger.Info("event=worker_reconnected", "session_id", id, "pid", st.PID)
		}
	}
}

// Reconcile 在原来的 Worker 已经不在时打开它的账本。套接字不通时，不会把账本里记下的进程号当成执行仍在继续，也不会新建空历史。
func (h *Host) Reconcile(ctx context.Context, sessionID string) error {
	if _, err := h.call(ctx, sessionID, func(c *Client) (Status, error) {
		return c.Status()
	}); err == nil {
		return nil
	}
	path, err := LedgerPath(h.DataDir, sessionID)
	if err != nil {
		return err
	}
	needs, err := LedgerNeedsWorker(path)
	if err != nil {
		return err
	}
	if !needs {
		return nil
	}
	return h.spawn(ctx, sessionID)
}

// Reachable 只探测原来的 Worker 是否还能应答。不会新建账本，也不会拉起进程。
func (h *Host) Reachable(ctx context.Context, sessionID string) bool {
	_, err := h.call(ctx, sessionID, func(c *Client) (Status, error) {
		return c.Status()
	})
	return err == nil
}

// Bind 确保 Session Worker 在运行，并把这次执行交给它。不会启动 Agent。
func (h *Host) Bind(ctx context.Context, sessionID, taskID, executionID, agentType string) (int, error) {
	call := func(c *Client) (Status, error) {
		return c.Bind(taskID, executionID, agentType)
	}
	if st, err := h.call(ctx, sessionID, call); err == nil {
		return st.PID, nil
	} else if errors.Is(err, ErrSessionBusy) {
		return 0, err
	}
	path, pathErr := LedgerPath(h.DataDir, sessionID)
	if pathErr != nil {
		return 0, pathErr
	}
	switch inspectErr := InspectLedger(path); {
	case errors.Is(inspectErr, ErrHistoryMissing):
		if err := CreateLedger(path); err != nil {
			return 0, err
		}
	case inspectErr != nil:
		return 0, inspectErr
	}
	if err := h.spawn(ctx, sessionID); err != nil {
		if st, err2 := h.call(ctx, sessionID, call); err2 == nil {
			return st.PID, nil
		}
		return 0, err
	}
	st, err := h.call(ctx, sessionID, call)
	if err != nil {
		return 0, err
	}
	if h.Logger != nil {
		h.Logger.Info("event=worker_started", "session_id", sessionID, "pid", st.PID)
	}
	return st.PID, nil
}

// Arm 让 Worker 记下许可请求的起点。不会启动执行器。
func (h *Host) Arm(ctx context.Context, sessionID, taskID, executionID string) (string, error) {
	st, err := h.call(ctx, sessionID, func(c *Client) (Status, error) {
		return c.Arm(taskID, executionID)
	})
	if err != nil {
		return "", err
	}
	return st.Nonce, nil
}

// Authorize 把许可交给 Worker。拒绝发生在 start_intent 之前时，Refused 为 true。
func (h *Host) Authorize(ctx context.Context, sessionID, taskID, executionID, permit, publicKey, generation, queueExpires string) (Status, error) {
	return h.call(ctx, sessionID, func(c *Client) (Status, error) {
		return c.Authorize(taskID, executionID, permit, publicKey, generation, queueExpires)
	})
}

// RejectStart 把中心拒绝交给原 Session，不产生新的执行身份或任务输入。
func (h *Host) RejectStart(ctx context.Context, sessionID, taskID, executionID, code string) error {
	call := func(c *Client) (Status, error) {
		return c.RejectStart(taskID, executionID, code)
	}
	if _, err := h.call(ctx, sessionID, call); err == nil {
		return nil
	}
	// 结果可能晚于 Worker 退出到达。仍由 Worker 写自己的账本。
	if err := h.Reconcile(ctx, sessionID); err != nil {
		return err
	}
	_, err := h.call(ctx, sessionID, call)
	return err
}

// SubmitInput 把任务输入交给 Worker。重复调用不会让执行器再收到一次。
func (h *Host) SubmitInput(ctx context.Context, sessionID, payload string) (Status, error) {
	return h.call(ctx, sessionID, func(c *Client) (Status, error) {
		return c.SubmitInput(payload)
	})
}

// Pending 读取 Worker 里还没有确认交付的报告。
func (h *Host) Pending(ctx context.Context, sessionID string) (Status, error) {
	return h.call(ctx, sessionID, func(c *Client) (Status, error) {
		return c.Pending()
	})
}

func (h *Host) Stop(ctx context.Context, sessionID, reason string) (Status, error) {
	return h.call(ctx, sessionID, func(c *Client) (Status, error) { return c.Stop(reason) })
}

// Ack 在中心确认持久化之后通知 Worker。
func (h *Host) Ack(ctx context.Context, sessionID, eventID string) (Status, error) {
	return h.call(ctx, sessionID, func(c *Client) (Status, error) {
		return c.Ack(eventID)
	})
}

func (h *Host) call(ctx context.Context, sessionID string, fn func(*Client) (Status, error)) (Status, error) {
	token, err := readToken(h.DataDir, sessionID)
	if err != nil {
		return Status{}, err
	}
	endpoint, err := Endpoint(h.DataDir, sessionID)
	if err != nil {
		return Status{}, err
	}
	client, err := Dial(ctx, endpoint, token)
	if err != nil {
		return Status{}, err
	}
	defer client.Close()
	return fn(client)
}

func (h *Host) spawn(ctx context.Context, sessionID string) error {
	if _, err := EnsureToken(h.DataDir, sessionID); err != nil {
		return err
	}
	null, err := os.Open(os.DevNull)
	if err != nil {
		return errors.New("无法启动 Worker")
	}
	defer null.Close()
	cmd, err := startWorkerProcess(func() *exec.Cmd {
		exe, execErr := os.Executable()
		if execErr != nil {
			exe = os.Args[0]
		}
		child := exec.Command(exe, "worker", "--data-dir", h.DataDir, "--session", sessionID)
		child.Stdout = null
		child.Stderr = null
		return child
	})
	if err != nil {
		return errors.New("无法启动 Worker")
	}
	go func() { _ = cmd.Wait() }()
	deadline := time.Now().Add(3 * time.Second)
	if until, ok := ctx.Deadline(); ok && until.Before(deadline) {
		deadline = until
	}
	endpoint, err := Endpoint(h.DataDir, sessionID)
	if err != nil {
		return err
	}
	for {
		probeCtx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
		conn, dialErr := dialEndpoint(probeCtx, endpoint)
		cancel()
		if dialErr == nil {
			conn.Close()
			return nil
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return errors.New("Worker 没有开始监听")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// EnsureToken 创建或读取仅当前用户可读的 Worker 认证令牌。
func EnsureToken(dataDir, sessionID string) (string, error) {
	path, err := TokenPath(dataDir, sessionID)
	if err != nil {
		return "", errors.New("Session 标识不正确")
	}
	dir, err := SessionDir(dataDir, sessionID)
	if err != nil {
		return "", errors.New("Session 标识不正确")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", errors.New("无法创建 Session 目录")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", errors.New("无法限制 Session 目录的权限")
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("无法生成 Worker 认证令牌")
	}
	token := hex.EncodeToString(raw)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, os.ErrExist) {
		return readToken(dataDir, sessionID)
	}
	if err != nil {
		return "", errors.New("无法保存 Worker 认证令牌")
	}
	_, writeErr := f.WriteString(token + "\n")
	closeErr := f.Close()
	if writeErr != nil || closeErr != nil {
		return "", errors.New("无法保存 Worker 认证令牌")
	}
	return token, nil
}

func readToken(dataDir, sessionID string) (string, error) {
	path, err := TokenPath(dataDir, sessionID)
	if err != nil {
		return "", errors.New("Session 标识不正确")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("无法读取 Worker 认证令牌")
	}
	token := string(raw)
	token = trimToken(token)
	if len(token) != 64 {
		return "", errors.New("Worker 认证令牌无效")
	}
	return token, nil
}

func trimToken(token string) string {
	for len(token) > 0 && (token[len(token)-1] == '\n' || token[len(token)-1] == '\r' || token[len(token)-1] == ' ') {
		token = token[:len(token)-1]
	}
	return token
}
