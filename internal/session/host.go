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

	"baton/internal/sidecar"
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
	db, _, err := openThreadDB(h.DataDir, ThreadOptions{ThreadID: sessionID}, false)
	if err != nil {
		return err
	}
	if err := db.Close(); err != nil {
		return classifyLedgerErr(err)
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
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := EnsureToken(h.DataDir, sessionID); err != nil {
		return err
	}
	null, err := os.Open(os.DevNull)
	if err != nil {
		return errors.New("无法启动 Worker")
	}
	defer null.Close()
	if err := ctx.Err(); err != nil {
		return err
	}
	cmd, err := sidecar.StartDetached(func() *exec.Cmd {
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
