package agent

import "testing"

func TestCLIVersionAtLeast(t *testing.T) {
	for _, tc := range []struct {
		version, minimum string
		want             bool
	}{
		{"1.3.0", "1.3.0", true}, {"1.4.0", "1.3.0", true}, {"1.10.0", "1.3.0", true},
		{"2.0.0", "1.3.0", true}, {"v1.4.0+build.12", "1.3.0", true},
		{"0.163.0", "0.162.1", true}, {"0.162.1", "0.162.1", true}, {"0.162.0", "0.162.1", false},
		{"2.33.1", "2.32.0", true}, {"1.2.99", "1.3.0", false}, {"0.99.0", "1.3.0", false},
		{"1.4.0-beta.1", "1.3.0", false}, {"1.4", "1.3.0", false}, {"unknown", "1.3.0", false},
		{"01.4.0", "1.3.0", false}, {"1.4.0+", "1.3.0", false}, {"1.4.0\n", "1.3.0", false},
		{"1.4.0", "bad", false}, {"18446744073709551616.0.0", "1.3.0", false},
	} {
		t.Run(tc.version+"/"+tc.minimum, func(t *testing.T) {
			if got := CLIVersionAtLeast(tc.version, tc.minimum); got != tc.want {
				t.Fatalf("got %t, want %t", got, tc.want)
			}
		})
	}
}
