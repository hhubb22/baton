//go:build windows

package session

import (
	"context"
	"net"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func listenEndpoint(addr string) (net.Listener, error) {
	return winio.ListenPipe(addr, pipeConfig())
}

func dialEndpoint(ctx context.Context, addr string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, addr)
}

func pipeConfig() *winio.PipeConfig {
	cfg := &winio.PipeConfig{}
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil {
		return cfg
	}
	cfg.SecurityDescriptor = "D:P(A;;GA;;;" + user.User.Sid.String() + ")"
	return cfg
}
