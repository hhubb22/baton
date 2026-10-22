package node

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"testing"

	"baton/internal/protocol"
)

func TestRuntimeReportTrimsLargeCatalogAndRetainsDefaultAndRoots(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	models := make([]protocol.RuntimeModel, 100)
	for i := range models {
		models[i] = protocol.RuntimeModel{ID: strings.Repeat("m", 508) + fmt.Sprintf("%04d", i), Name: strings.Repeat("M", 512)}
	}
	defaultModel := models[len(models)-1].ID
	calls := 0
	cache := &runtimeModelCache{discover: func(context.Context, string, string) ([]protocol.RuntimeModel, string, error) {
		calls++
		return models, defaultModel, nil
	}}
	probe := agentRuntimeProbe{
		lookup: func(name string) (string, error) {
			if name == "pi" {
				return "/bin/pi", nil
			}
			return "", exec.ErrNotFound
		},
		version:  func(context.Context, string) (string, error) { return "1.0.0", nil },
		verified: func(string, string) bool { return true },
		models:   cache.models,
	}
	dir := t.TempDir()
	if err := AddBrowseRoot(dir, "work", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		report, details := collectRuntimeReportUsingProbe(t.Context(), dir, probe)
		raw, err := runtimeReportWireJSON(report, &details)
		if err != nil || len(raw) > protocol.MaxRuntimeReportBytes || !report.Truncated {
			t.Fatalf("大目录报告超限：bytes=%d truncated=%v err=%v", len(raw), report.Truncated, err)
		}
		pi := report.Agents[0]
		if len(pi.Models) == 0 || len(pi.Models) >= len(models) || pi.DefaultModel != defaultModel {
			t.Fatalf("大目录模型被整体清空或默认模型丢失：models=%d default=%q", len(pi.Models), pi.DefaultModel)
		}
		foundDefault := false
		for _, model := range pi.Models {
			foundDefault = foundDefault || model.ID == defaultModel
		}
		if !foundDefault || len(report.Roots) != 1 || report.Roots[0].RootID != "work" {
			t.Fatalf("裁剪没有保留默认模型及授权目录：foundDefault=%v roots=%+v", foundDefault, report.Roots)
		}
		if calls != 1 || len(cache.entries["pi"].models) != len(models) || len(details[0].Models) != len(models) {
			t.Fatal("报告裁剪污染了缓存或诊断快照")
		}
	}
}
