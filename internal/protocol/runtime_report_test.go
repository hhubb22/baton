package protocol

import (
	"strings"
	"testing"
)

func TestRuntimeOriginsStripCredentials(t *testing.T) {
	for raw, want := range map[string]string{
		"https://user:password@github.com/team/repo.git?token=secret#fragment": "github.com/team/repo.git",
		"ssh://user:password@git.example:222/team/repo":                        "git.example/team/repo",
		"git@github.com:team/repo.git":                                         "github.com/team/repo.git",
		"github.com/team/repo":                                                 "",
		"../private/repo":                                                      "", "private/repo": "",
		"file:///private/secrets": "", "C:\\secret": "", "ext::secret-command": "",
		"https://host/team\nsecret": "",
	} {
		if got := SanitizeOrigin(raw); got != want {
			t.Errorf("origin 脱敏不符合预期：%q", got)
		}
	}
}

func TestRuntimeReportRejectsSecretsAndOversize(t *testing.T) {
	for _, raw := range []string{
		`{"version":"1.0","providers":[],"token":"secret"}`,
		`{"version":"1.0","providers":[{"provider":"openai-codex","status":"available","access_token":"secret"}]}`,
		`{"version":"1.0","providers":[]} {}`,
	} {
		var p ProjectRuntime
		if DecodeRuntimeJSON([]byte(raw), &p) == nil {
			t.Fatal("接受了契约之外的数据")
		}
	}
	r := RuntimeReport{Exec: RuntimeExec{Shell: "sh"}, Repos: []RuntimeRepo{{Path: "/repo", Origin: "https://user:secret@host/repo"}}}
	if _, err := RuntimeReportJSON(r); err == nil {
		t.Fatal("接受了带凭据的 origin")
	}
	r.Repos = nil
	for i := 0; i < 128; i++ {
		r.Repos = append(r.Repos, RuntimeRepo{Path: "/" + strings.Repeat("x", 1000)})
	}
	if _, err := RuntimeReportJSON(r); err == nil {
		t.Fatal("接受了超过 64 KiB 的报告")
	}
}
