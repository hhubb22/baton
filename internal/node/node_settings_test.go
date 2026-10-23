package node

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"baton/internal/identity"
	"baton/internal/protocol"
)

func TestBrowseSettingsAndLoginRefresh(t *testing.T) {
	op, _ := identity.NewUUID()
	reports := &runtimeReports{refresh: make(chan struct{}, 1)}
	raw, _ := json.Marshal(protocol.SubscriptionLoginRequest{Type: protocol.BodySubscriptionLogin, OperationID: op, Provider: "xai"})
	var done func()
	result := startSubscriptionLogin(t.Context(), raw, reports, func(ctx context.Context, provider string, onDone func()) (protocol.SubscriptionLoginResult, error) {
		if provider != "xai" {
			t.Fatal(provider)
		}
		done = onDone
		return protocol.SubscriptionLoginResult{OK: true, Provider: provider}, nil
	})
	if !result.OK || result.Type != protocol.BodySubscriptionLoginResult || result.OperationID != op {
		t.Fatal(result)
	}
	select {
	case <-reports.refresh:
		t.Fatal("登录完成前刷新")
	default:
	}
	done()
	done()
	select {
	case <-reports.refresh:
	default:
		t.Fatal("登录完成未触发刷新")
	}
	failed := startSubscriptionLogin(t.Context(), raw, reports, func(context.Context, string, func()) (protocol.SubscriptionLoginResult, error) {
		return protocol.SubscriptionLoginResult{}, errors.New("私有诊断")
	})
	if failed.OK || failed.Code != "login_unavailable" || failed.Message == "私有诊断" {
		t.Fatal(failed)
	}
}
