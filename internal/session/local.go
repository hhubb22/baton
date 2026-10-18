package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"path/filepath"
	"runtime"
)

// AgentEndpoint 与 Worker 共用当前用户限定的 IPC 目录或命名管道 ACL。
func AgentEndpoint(dataDir string) (string, error) {
	endpoint, err := Endpoint(dataDir, "00000000-0000-4000-8000-000000000000")
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" {
		abs, err := filepath.Abs(dataDir)
		if err != nil {
			return "", err
		}
		sum := sha256.Sum256([]byte(abs))
		return endpoint + "-agent-" + hex.EncodeToString(sum[:16]), nil
	}
	return filepath.Join(filepath.Dir(endpoint), "agent.sock"), nil
}

func ListenLocal(endpoint string) (net.Listener, error) { return listenEndpoint(endpoint) }

func DialLocal(ctx context.Context, endpoint string) (net.Conn, error) {
	return dialEndpoint(ctx, endpoint)
}

func AgentContextPath(dataDir, sessionID, executionID string) (string, error) {
	dir, err := SessionDir(dataDir, sessionID)
	if err != nil {
		return "", err
	}
	// SessionDir 同时用于校验 execution UUID，不能把调用方路径拼入文件名。
	executionDir, err := SessionDir(dataDir, executionID)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "agent-"+filepath.Base(executionDir)+".json"), nil
}
