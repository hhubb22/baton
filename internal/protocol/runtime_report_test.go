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

func TestRuntimeMessageCompatibility(t *testing.T) {
	for _, tc := range []struct {
		raw string
		ok  bool
	}{
		{`{"version":"0.1.0","providers":[{"provider":"test","status":"available","future":true}],"future":{"enabled":true}}`, true},
		{`{"providers":[]}`, false},
		{`{"version":42,"providers":[]}`, false},
		{`{"version":"0.1.0","providers":[{"provider":"test","status":"invalid"}]}`, false},
		{`{"version":"0.1.0","providers":[]} {}`, false},
		{strings.Repeat(" ", MaxRuntimeReportBytes+1), false},
		{"{\"version\":\"\xff\"}", false},
	} {
		var p ProjectRuntime
		ok := DecodeRuntimeMessage([]byte(tc.raw), &p) == nil && ValidateProjectRuntime(&p) == nil
		if ok != tc.ok {
			t.Fatalf("能力探测兼容结果不符: %+v", p)
		}
		if ok && (p.Version != "0.1.0" || len(p.Providers) != 1 || p.Providers[0].Status != "available") {
			t.Fatal("已知字段改变")
		}
	}
	raw := []byte(`{"exec":{"enabled":true,"shell":"sh","future":true},"roots":[{"root_id":"repo","path":"/repo","future":true}],"repos":[],"future":true}`)
	var report RuntimeReport
	if DecodeRuntimeMessage(raw, &report) != nil {
		t.Fatal("能力报告未忽略嵌套未知字段")
	}
	saved, err := RuntimeReportJSON(report)
	if err != nil || strings.Contains(string(saved), "future") || !report.Exec.Enabled || report.Roots[0].RootID != "repo" {
		t.Fatalf("报告已知字段改变或保存未知字段: %s %v", saved, err)
	}
	for _, raw := range []string{`{"roots":[]}`, `{"exec":{"shell":42}}`} {
		var report RuntimeReport
		if DecodeRuntimeMessage([]byte(raw), &report) == nil {
			if _, err := RuntimeReportJSON(report); err == nil {
				t.Fatal("接受了缺少必填字段或类型错误的报告")
			}
		}
	}
}
