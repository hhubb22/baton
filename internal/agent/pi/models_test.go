package pi

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"baton/internal/agent"
)

func TestThreadSwitchFailureNeverPrompts(t *testing.T) {
	for _, failure := range []string{"invalid-id", "rpc-rejected", "transport"} {
		t.Run(failure, func(t *testing.T) {
			a := historyAdapter(t)
			a.done = make(chan struct{})
			a.model = "magpie/auto/gpt-6.1-sol"
			var calls []string
			cause := errors.New("transport failed")
			a.in = threadRPCWriter{write: func(raw []byte) error {
				var c struct{ Type, ID, Provider, ModelID string }
				if err := json.Unmarshal(raw, &c); err != nil {
					return err
				}
				calls = append(calls, c.Type)
				if c.Type != "set_model" || c.Provider != "openai" || c.ModelID != "gpt-6-luna" {
					t.Errorf("切换失败前发送了非预期帧: %s", raw)
				}
				if failure == "transport" {
					return cause
				}
				raw, _ = json.Marshal(map[string]any{"type": "response", "id": c.ID, "command": "set_model", "success": false, "error": "model unavailable"})
				return a.consume(raw)
			}}
			model := "openai/gpt-6-luna"
			if failure == "invalid-id" {
				model = "invalid"
			}
			err := a.Send(context.Background(), "not-sent", "question", model)
			var selection *agent.ModelSwitchError
			if !errors.As(err, &selection) {
				t.Fatalf("切换错误类型: %v", err)
			}
			if failure == "transport" && !errors.Is(err, cause) {
				t.Fatal("未保留底层错误", err)
			}
			if failure == "invalid-id" && len(calls) != 0 {
				t.Fatal(calls)
			}
			if failure != "invalid-id" && !reflect.DeepEqual(calls, []string{"set_model"}) {
				t.Fatal(calls)
			}
			if a.active || len(a.intents) != 0 || len(a.DrainEvents()) != 0 || a.Model() != "magpie/auto/gpt-6.1-sol" {
				t.Fatal("失败切换改变了发送事实")
			}
		})
	}
}

func TestThreadBusyCannotSwitchModel(t *testing.T) {
	a := historyAdapter(t)
	a.done = make(chan struct{})
	a.active = true
	a.in = threadRPCWriter{write: func([]byte) error { t.Error("执行中发出了切换请求"); return nil }}
	if err := a.Send(context.Background(), "busy", "text", "openai/gpt-6-luna"); !errors.Is(err, agent.ErrBusy) {
		t.Fatal(err)
	}
}
