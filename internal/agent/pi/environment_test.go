package pi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsolatedEnvVertexKey(t *testing.T) {
	const key = "GOOGLE_CLOUD_API_KEY"
	value := "vertex-test-placeholder"
	t.Setenv(key, value)
	t.Setenv("BATON_UNRELATED_SECRET", "not-for-pi")
	home := t.TempDir()
	env := make(map[string]string)
	for _, entry := range IsolatedEnv(home) {
		name, value, _ := strings.Cut(entry, "=")
		env[name] = value
	}
	if env[key] != value {
		t.Fatal("Vertex API key was not forwarded")
	}
	if _, ok := env["BATON_UNRELATED_SECRET"]; ok {
		t.Fatal("unrelated environment leaked")
	}
	if env["HOME"] != home || env["PI_CODING_AGENT_DIR"] != filepath.Join(home, "pi") {
		t.Fatal("Pi home is not isolated")
	}
	if err := os.Unsetenv(key); err != nil {
		t.Fatal(err)
	}
	for _, entry := range IsolatedEnv(home) {
		if strings.HasPrefix(entry, key+"=") {
			t.Fatal("absent Vertex API key was invented")
		}
	}
}
