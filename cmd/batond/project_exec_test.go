package main

import (
	"context"
	"io"
	"testing"

	"baton/internal/node"
)

func TestProjectExecRequiresExplicitSwitch(t *testing.T) {
	dir := t.TempDir()
	for _, enabled := range []string{"true", "false"} {
		if err := run(context.Background(), []string{"project-exec", "--data-dir", dir, "--enabled=" + enabled, "--shell", "sh"}, io.Discard, io.Discard, nil); err != nil {
			t.Fatal(err)
		}
		cfg, err := node.ReadProjectExec(dir)
		if err != nil || cfg.Enabled != (enabled == "true") || cfg.Shell != "sh" {
			t.Fatalf("配置未保存：%+v %v", cfg, err)
		}
	}
	if run(context.Background(), []string{"project-exec", "--data-dir", dir}, io.Discard, io.Discard, nil) == nil {
		t.Fatal("未明确指定开关仍然写入")
	}
}
