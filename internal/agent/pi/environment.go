package pi

import (
	"os"
	"path/filepath"
)

// IsolatedEnv opts out of existing home/config/auth files. Provider credentials
// stay in the process environment; no key is copied to a file or argument.
func IsolatedEnv(home string) []string {
	env := []string{"HOME=" + home, "USERPROFILE=" + home, "PI_CODING_AGENT_DIR=" + filepath.Join(home, "pi"),
		"XDG_CONFIG_HOME=" + filepath.Join(home, "config"), "XDG_CACHE_HOME=" + filepath.Join(home, "cache"), "TMPDIR=" + filepath.Join(home, "tmp")}
	for _, key := range []string{"PATH", "SystemRoot", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
		"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "ZAI_API_KEY"} {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}
