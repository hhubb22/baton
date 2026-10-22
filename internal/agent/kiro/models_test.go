package kiro

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"baton/internal/agent"
)

func TestThreadRejectsModelSwitchBeforeNativeIO(t *testing.T) {
	a := New(agent.Config{Model: "auto"})
	defer a.Close()
	a.state.NativeID = "native"
	err := a.Send(context.Background(), "message", "text", "gpt-6-luna")
	var selection *agent.ModelSwitchError
	if !errors.As(err, &selection) || !errors.Is(err, agent.ErrUnsupported) {
		t.Fatalf("不支持换模型的错误: %v", err)
	}
	if a.state.Pending || a.active || len(a.intents) != 0 || len(a.DrainEvents()) != 0 {
		t.Fatal("换模型请求写入了发送事实")
	}
	if a.Capabilities().SwitchModel {
		t.Fatal("Kiro 上报了未经验证的换模型能力")
	}
}

func TestNativeModelCatalogShapes(t *testing.T) {
	for _, raw := range []string{
		`{"models":{"currentModelId":"auto","availableModels":[{"modelId":"auto","name":"Auto"},{"modelId":"luna","name":"Luna"}]}}`,
		`{"configOptions":[{"id":"model","category":"model","currentValue":"auto","options":[{"value":"auto","name":"Auto"},{"value":"luna","name":"Luna"}]}]}`,
	} {
		var r newSessionResult
		if err := json.Unmarshal([]byte(raw), &r); err != nil {
			t.Fatal(err)
		}
		c := r.catalog()
		if c.DefaultModel != "auto" || len(c.Models) != 2 || c.Models[0].ID != "auto" || c.Models[1].Name != "Luna" {
			t.Fatal(c)
		}
	}
}
