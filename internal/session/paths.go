package session

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"baton/internal/identity"
)

// SessionDir 是一个 Session 的本地目录。sessionID 必须是 UUID，避免路径跳出数据目录。
func SessionDir(dataDir, sessionID string) (string, error) {
	id, err := identity.ParseUUID(sessionID)
	if err != nil {
		return "", err
	}
	return filepath.Join(dataDir, "sessions", id), nil
}

func TokenPath(dataDir, sessionID string) (string, error) {
	dir, err := SessionDir(dataDir, sessionID)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "token"), nil
}

func LockPath(dataDir, sessionID string) (string, error) {
	dir, err := SessionDir(dataDir, sessionID)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "session.lock"), nil
}

func LogPath(dataDir, sessionID string) (string, error) {
	dir, err := SessionDir(dataDir, sessionID)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "worker.log"), nil
}

// Endpoint 是 Worker 的本地监听地址。Windows 用命名管道。
// Unix 套接字路径必须放进 sockaddr_un，会话目录经常超过这个上限，所以套接字放在仅当前用户可进入的短路径下。
func Endpoint(dataDir, sessionID string) (string, error) {
	id, err := identity.ParseUUID(sessionID)
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" {
		return `\\.\pipe\baton-` + id, nil
	}
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(abs))
	dir := filepath.Join("/tmp", fmt.Sprintf("baton-%d", os.Getuid()), hex.EncodeToString(sum[:4]))
	return filepath.Join(dir, id+".sock"), nil
}
