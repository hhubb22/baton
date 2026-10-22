package session

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"

	"baton/internal/sidecar"

	"github.com/gofrs/flock"
)

// RunWorker 取得 Thread 的文件锁，守护 Agent 进程并提供认证 IPC。
func RunWorker(ctx context.Context, dataDir, sessionID string) error {
	dir, err := SessionDir(dataDir, sessionID)
	if err != nil {
		return errors.New("Session 标识不正确")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return errors.New("无法创建 Session 目录")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return errors.New("无法限制 Session 目录的权限")
	}
	lockPath, err := LockPath(dataDir, sessionID)
	if err != nil {
		return err
	}
	lock := flock.New(lockPath)
	ok, err := lock.TryLock()
	if err != nil {
		return errors.New("无法锁定 Session")
	}
	if !ok {
		return ErrSessionOwned
	}
	defer lock.Unlock()
	release, err := sidecar.HoldProcessGroupJob()
	if err != nil {
		return errors.New("无法创建 Agent Job")
	}
	defer release()
	tokenPath, err := TokenPath(dataDir, sessionID)
	if err != nil {
		return err
	}
	token, err := os.ReadFile(tokenPath)
	if err != nil {
		return errors.New("无法读取 Worker 认证令牌")
	}
	tokenText := strings.TrimSpace(string(token))
	if len(tokenText) != 64 {
		return errors.New("Worker 认证令牌无效")
	}
	logPath, err := LogPath(dataDir, sessionID)
	if err != nil {
		return err
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return errors.New("无法写入 Worker 日志")
	}
	defer logFile.Close()
	logger := slog.New(slog.NewTextHandler(logFile, nil))
	return runThreadWorker(ctx, dataDir, sessionID, tokenText, logger)
}
