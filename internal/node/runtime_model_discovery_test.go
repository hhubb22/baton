package node

import (
	"context"
	"reflect"
	"testing"

	"baton/internal/protocol"
)

func TestRuntimeModelDiscoveryInjection(t *testing.T) {
	want := []protocol.RuntimeModel{{ID: "pi/model", Name: "Model"}}
	calls := 0
	probe := newAgentProbe(func(ctx context.Context, name, path string) ([]protocol.RuntimeModel, string, error) {
		calls++
		if name != "pi" || path != "/missing/agent" {
			t.Fatalf("模型探测参数错误：%q %q", name, path)
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("注入探测没有期限")
		}
		return want, "pi/model", nil
	}, nil)
	for range 2 {
		models, defaultModel := probe.models(t.Context(), "pi", "/missing/agent", "1.0.0")
		if !reflect.DeepEqual(models, want) || defaultModel != "pi/model" || calls != 1 {
			t.Fatalf("注入探测或缓存错误：%+v %q calls=%d", models, defaultModel, calls)
		}
	}
}
