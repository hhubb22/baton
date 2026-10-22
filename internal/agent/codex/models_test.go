package codex

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"baton/internal/agent"
	"github.com/sourcegraph/jsonrpc2"
)

func TestThreadModelSelectionAndRPCRejection(t *testing.T) {
	a := New(Config{Model: "gpt-6.1-sol", StatePath: filepath.Join(t.TempDir(), "state.json")})
	a.state = State{ThreadID: "thread", Model: "gpt-6.1-sol"}
	attempt := 0
	unitRPC(t, a, func(method string, raw json.RawMessage) (any, error) {
		if method != "turn/start" {
			t.Errorf("unexpected %s", method)
		}
		var p struct{ ThreadID, Model string }
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		if p.ThreadID != "thread" || p.Model != "gpt-6-luna" {
			t.Errorf("model request: %s", raw)
		}
		attempt++
		if attempt == 1 {
			// 明确 RPC 拒绝无法由已完成的真实转录按需产生。
			return nil, &jsonrpc2.Error{Code: jsonrpc2.CodeInvalidParams, Message: "model unavailable"}
		}
		return map[string]any{"turn": map[string]string{"id": "turn", "status": "inProgress"}}, nil
	})
	err := a.Send(context.Background(), "rejected", "question", "gpt-6-luna")
	var selection *agent.ModelSwitchError
	var rpcErr *jsonrpc2.Error
	if !errors.As(err, &selection) || !errors.As(err, &rpcErr) || !errors.Is(err, ErrIncompatible) {
		t.Fatalf("RPC 拒绝没有保留错误类型: %v", err)
	}
	if a.state.Pending || a.state.Model != "gpt-6.1-sol" || a.config.Model != "gpt-6.1-sol" || len(a.DrainEvents()) != 0 {
		t.Fatalf("被拒绝的消息改变了运行事实: %+v", a.state)
	}
	if err := a.Send(context.Background(), "accepted", "question", "gpt-6-luna"); err != nil {
		t.Fatal(err)
	}
	a.notification("turn/completed", json.RawMessage(`{"threadId":"thread","turn":{"id":"turn","status":"completed"}}`))
	if err := a.Send(context.Background(), "inherited", "question", ""); err != nil {
		t.Fatal(err)
	}
	if a.state.Model != "gpt-6-luna" {
		t.Fatal(a.state.Model)
	}
}

func TestThreadRPCRejectionWithoutModelChangeRemainsUncertain(t *testing.T) {
	for _, model := range []string{"", "gpt-6.1-sol"} {
		t.Run("model="+model, func(t *testing.T) {
			a := New(Config{Model: "gpt-6.1-sol", StatePath: filepath.Join(t.TempDir(), "state.json")})
			a.state = State{ThreadID: "thread", Model: "gpt-6.1-sol"}
			unitRPC(t, a, func(string, json.RawMessage) (any, error) {
				return nil, &jsonrpc2.Error{Code: jsonrpc2.CodeInvalidParams, Message: "invalid input"}
			})
			err := a.Send(context.Background(), "message", "question", model)
			var selection *agent.ModelSwitchError
			if err == nil || errors.As(err, &selection) || !errors.Is(err, ErrIncompatible) || !a.state.Pending || a.state.OperationID != "message" {
				t.Fatalf("ordinary RPC error lost send intent: %v %+v", err, a.state)
			}
			events := a.DrainEvents()
			if len(events) != 1 || events[0].Kind != agent.EventUncertain {
				t.Fatal(events)
			}
		})
	}
}

func TestThreadNetworkErrorRemainsUncertain(t *testing.T) {
	a := New(Config{StatePath: filepath.Join(t.TempDir(), "state.json")})
	a.state = State{ThreadID: "thread"}
	unitRPC(t, a, func(string, json.RawMessage) (any, error) { return nil, nil })
	if err := a.conn.Close(); err != nil {
		t.Fatal(err)
	}
	err := a.Send(context.Background(), "message", "question", "gpt-6-luna")
	var selection *agent.ModelSwitchError
	if err == nil || errors.As(err, &selection) || !a.state.Pending {
		t.Fatalf("网络错误被当作确定未发送: %v %+v", err, a.state)
	}
	events := a.DrainEvents()
	if len(events) != 1 || events[0].Kind != agent.EventUncertain {
		t.Fatal(events)
	}
}

func TestModelsConfiguredDefaultTakesPriority(t *testing.T) {
	a := New(Config{Model: "gpt-6-luna"})
	unitRPC(t, a, func(string, json.RawMessage) (any, error) {
		return map[string]any{"data": []any{
			map[string]any{"model": "gpt-6.1-sol", "isDefault": true},
			map[string]any{"model": "gpt-6-luna"},
		}}, nil
	})
	c, err := a.Models(context.Background())
	if err != nil || c.DefaultModel != "gpt-6-luna" {
		t.Fatal(c, err)
	}
}

func TestModelsUsesNativeIDsAndPagination(t *testing.T) {
	for _, cycle := range []bool{false, true} {
		t.Run(map[bool]string{false: "pages", true: "cursor-cycle"}[cycle], func(t *testing.T) {
			a := New(Config{})
			calls := 0
			unitRPC(t, a, func(method string, raw json.RawMessage) (any, error) {
				if method != "model/list" {
					t.Errorf("unexpected %s", method)
				}
				var p struct {
					Cursor        *string
					IncludeHidden bool
				}
				if err := json.Unmarshal(raw, &p); err != nil {
					return nil, err
				}
				if p.IncludeHidden || (calls == 0 && p.Cursor != nil) || (calls > 0 && (p.Cursor == nil || *p.Cursor != "next")) {
					t.Errorf("cursor: %s", raw)
				}
				calls++
				if calls == 1 || cycle {
					return map[string]any{"data": []any{map[string]any{"id": "ui-id", "model": "gpt-6.1-sol", "displayName": "Sol", "isDefault": true}}, "nextCursor": "next"}, nil
				}
				return map[string]any{"data": []any{map[string]any{"model": "gpt-6-luna", "displayName": "Luna"}, map[string]any{"model": "hidden", "hidden": true}}}, nil
			})
			c, err := a.Models(context.Background())
			if cycle {
				if err == nil || len(c.Models) != 0 {
					t.Fatal(c, err)
				}
				return
			}
			if err != nil || c.DefaultModel != "gpt-6.1-sol" || len(c.Models) != 2 || c.Models[0].ID != "gpt-6.1-sol" || c.Models[1].ID != "gpt-6-luna" {
				t.Fatal(c, err)
			}
		})
	}
}
