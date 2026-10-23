package projectexec

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"baton/internal/fileaccess"
	"baton/internal/privatefile"
	"baton/internal/protocol"
	"github.com/gofrs/flock"
)

const FileName = "project-exec.json"

func DefaultProjectShell() string {
	if runtime.GOOS == "windows" {
		return "pwsh"
	}
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return shell
	}
	return "/bin/sh"
}

func ReadProjectExec(dir string) (protocol.RuntimeExec, error) {
	cfg := protocol.RuntimeExec{Shell: DefaultProjectShell()}
	f, err := privatefile.Open(filepath.Join(dir, FileName))
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return protocol.RuntimeExec{}, errors.New("无法读取 Project Agent 命令配置")
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 8193))
	if err != nil || len(raw) > 8192 || protocol.DecodeRuntimeJSON(raw, &cfg) != nil || validateProjectExec(cfg) != nil {
		return protocol.RuntimeExec{}, errors.New("Project Agent 命令配置无效")
	}
	return cfg, nil
}

func validateProjectExec(cfg protocol.RuntimeExec) error {
	_, err := protocol.RuntimeReportJSON(protocol.RuntimeReport{Exec: cfg})
	return err
}

// WriteProjectExec 原子保存本机开关；报告循环会重新读取，不需要重启连接。
func WriteProjectExec(dir string, cfg protocol.RuntimeExec) error {
	if err := fileaccess.PrepareDataDir(dir); err != nil {
		return err
	}
	lock := flock.New(filepath.Join(dir, "project-exec.lock"))
	if err := lock.Lock(); err != nil {
		return err
	}
	defer lock.Unlock()
	return writeProjectExec(dir, cfg)
}

// SetEnabled 保留本机 shell，在同一文件锁内保存并回读授权状态。
func SetEnabled(dir string, enabled bool) (protocol.RuntimeExec, error) {
	if err := fileaccess.PrepareDataDir(dir); err != nil {
		return protocol.RuntimeExec{}, err
	}
	lock := flock.New(filepath.Join(dir, "project-exec.lock"))
	if err := lock.Lock(); err != nil {
		return protocol.RuntimeExec{}, err
	}
	defer lock.Unlock()
	cfg, err := ReadProjectExec(dir)
	if err != nil {
		return protocol.RuntimeExec{}, err
	}
	cfg.Enabled = enabled
	if err := writeProjectExec(dir, cfg); err != nil {
		return protocol.RuntimeExec{}, err
	}
	return ReadProjectExec(dir)
}

func writeProjectExec(dir string, cfg protocol.RuntimeExec) error {
	if validateProjectExec(cfg) != nil {
		return errors.New("Project Agent 命令配置无效")
	}
	if err := fileaccess.PrepareDataDir(dir); err != nil {
		return err
	}
	// 使用固定字段序列化，配置文件不保存任何凭据。
	raw, err := json.Marshal(struct {
		Enabled bool   `json:"enabled"`
		Shell   string `json:"shell"`
	}{cfg.Enabled, cfg.Shell})
	if err != nil {
		return err
	}
	if privatefile.WriteFile(filepath.Join(dir, FileName), raw) != nil {
		return errors.New("无法保存 Project Agent 命令配置")
	}
	return nil
}
