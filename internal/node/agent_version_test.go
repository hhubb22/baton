package node

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestAgentReportAndExecutionUseSameVersionPolicy(t *testing.T) {
	probe := newAgentProbe(nil, nil)
	for _, tc := range []struct {
		name, version string
		want          bool
	}{
		{"pi", "1.4.0", true}, {"pi", "2.0.0", true}, {"pi", "1.2.0", false},
		{"codex", "0.164.0", true}, {"codex", "0.161.0", false},
		{"kiro", "2.33.1", true}, {"kiro", "2.31.0", false},
		{"pi", "unknown", false}, {"other", "99.0.0", false},
	} {
		if got := probe.verified(tc.name, tc.version); got != tc.want {
			t.Errorf("%s %s: got=%t want=%t", tc.name, tc.version, got, tc.want)
		}
	}
}

func TestThreadAgentAvailabilityDoesNotUseRegistrationCaps(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix executable fixture")
	}
	binary := filepath.Join(t.TempDir(), "pi")
	t.Setenv("BATON_PI_BIN", binary)
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 99\n"), 0700); err != nil {
		t.Fatal(err)
	}
	s := &threadService{}
	// 此处只核实程序存在；版本与协议初始化由适配器统一检查。
	if err := s.agentAvailable(context.Background(), "pi"); err != nil {
		t.Fatalf("empty registration capabilities rejected detected Pi: %v", err)
	}
	if err := os.Remove(binary); err != nil {
		t.Fatal(err)
	}
	if err := s.agentAvailable(context.Background(), "pi"); err == nil {
		t.Fatal("missing Agent executable was accepted")
	}
}
