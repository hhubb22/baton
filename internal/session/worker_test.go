package session

import (
	"context"
	"testing"
	"time"

	"baton/internal/identity"
)

func waitClient(t *testing.T, endpoint, token string) *Client {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		client, err := Dial(ctx, endpoint, token)
		cancel()
		if err == nil {
			return client
		}
		last = err
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal(last)
	return nil
}

func mustSessionID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
