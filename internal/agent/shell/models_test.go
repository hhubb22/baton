package shell

import (
	"context"
	"errors"
	"testing"

	"baton/internal/agent"
)

func TestThreadModelRejectedBeforeCommand(t *testing.T) {
	a := New(agent.Config{})
	err := a.Send(context.Background(), "message", "echo forbidden", "gpt-6-luna")
	var selection *agent.ModelSwitchError
	if !errors.As(err, &selection) || !errors.Is(err, agent.ErrUnsupported) {
		t.Fatalf("shell 模型错误: %v", err)
	}
	if a.submitted || a.process != nil || a.Capabilities().SwitchModel {
		t.Fatal("shell 模型请求启动了命令或启用了换模型能力")
	}
}
