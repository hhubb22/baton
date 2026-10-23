package agent_test

import (
	"baton/internal/agent/codex"
	"baton/internal/agent/kiro"
	"baton/internal/agent/pi"
	"testing"
)

func TestAdapterMinimumVersions(t *testing.T) {
	for _, tc := range []struct {
		name                          string
		supported                     func(string) bool
		minimum, current, future, old string
	}{
		{"pi", pi.SupportsVersion, "1.3.0", "1.4.0", "2.0.0", "1.2.99"},
		{"codex", codex.SupportsVersion, "0.162.1", "0.163.0", "1.0.0", "0.162.0"},
		{"kiro", kiro.SupportsVersion, "2.32.0", "2.33.1", "3.0.0", "2.31.99"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, version := range []string{tc.minimum, tc.current, tc.future, tc.current + "+build.12"} {
				if !tc.supported(version) {
					t.Errorf("rejected supported release %q", version)
				}
			}
			for _, version := range []string{tc.old, "unknown", tc.current + "-beta.1", tc.current + "garbage"} {
				if tc.supported(version) {
					t.Errorf("accepted unsupported release %q", version)
				}
			}
		})
	}
}
