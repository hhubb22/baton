package session

import (
	"context"
	"net"
)

func ListenLocal(endpoint string) (net.Listener, error) { return listenEndpoint(endpoint) }

func DialLocal(ctx context.Context, endpoint string) (net.Conn, error) {
	return dialEndpoint(ctx, endpoint)
}
