//go:build !windows

package session

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

func listenEndpoint(addr string) (net.Listener, error) {
	if err := prepareSocketDir(filepath.Dir(addr)); err != nil {
		return nil, err
	}
	if conn, err := net.DialTimeout("unix", addr, 50*time.Millisecond); err == nil {
		conn.Close()
		return nil, errEndpointBusy
	}
	_ = os.Remove(addr)
	ln, err := net.Listen("unix", addr)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(addr, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

func prepareSocketDir(dir string) error {
	parent := filepath.Dir(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for _, path := range []string{parent, dir} {
		if err := os.Chmod(path, 0o700); err != nil {
			return err
		}
		if err := ownSocketDir(path); err != nil {
			return err
		}
	}
	return nil
}

func ownSocketDir(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return errors.New("Worker 套接字目录无效")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() {
		return errors.New("Worker 套接字目录不属于当前用户")
	}
	return nil
}

func dialEndpoint(ctx context.Context, addr string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", addr)
}
