package protocol

import (
	"strings"
	"testing"
)

func TestRuntimeAgentModels(t *testing.T) {
	base := RuntimeAgent{
		AgentType: "pi", Version: "1.2.3", Status: "available",
		Models:       []RuntimeModel{{ID: "magpie/auto/gpt-6.1-sol", Name: "GPT 6.1"}},
		DefaultModel: "magpie/auto/gpt-6.1-sol", Capabilities: ThreadCapabilities{Create: true, SwitchModel: true},
	}
	report := func(a RuntimeAgent) ([]byte, error) {
		return RuntimeReportJSON(RuntimeReport{Exec: RuntimeExec{Shell: "sh"}, Agents: []RuntimeAgent{a}})
	}
	raw, err := report(base)
	if err != nil {
		t.Fatal(err)
	}
	var decoded RuntimeReport
	if DecodeRuntimeMessage(raw, &decoded) != nil || len(decoded.Agents) != 1 {
		t.Fatalf("模型报告无法读取：%s", raw)
	}
	got := decoded.Agents[0]
	if len(got.Models) != 1 || got.Models[0] != base.Models[0] || got.DefaultModel != base.DefaultModel || !got.Capabilities.SwitchModel {
		t.Fatalf("模型字段丢失：%+v", got)
	}
	for _, tc := range []struct {
		name  string
		model RuntimeModel
		ok    bool
	}{
		{"maximum ID", RuntimeModel{ID: strings.Repeat("x", 512), Name: "Model"}, true},
		{"oversize ID", RuntimeModel{ID: strings.Repeat("x", 513), Name: "Model"}, false},
		{"multibyte ID", RuntimeModel{ID: strings.Repeat("模", 171), Name: "Model"}, false},
		{"empty ID", RuntimeModel{Name: "Model"}, false},
		{"empty name", RuntimeModel{ID: "model"}, false},
		{"control ID", RuntimeModel{ID: "model\nsecret", Name: "Model"}, false},
		{"control name", RuntimeModel{ID: "model", Name: "Model\x00"}, false},
		{"invalid UTF-8", RuntimeModel{ID: "\xff", Name: "Model"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := base
			a.Models = []RuntimeModel{tc.model}
			if _, err := report(a); (err == nil) != tc.ok {
				t.Fatalf("模型校验结果错误：%v", err)
			}
		})
	}
	a := base
	a.Models = append(a.Models, a.Models[0])
	if _, err := report(a); err == nil {
		t.Fatal("接受了重复模型 ID")
	}
	for _, defaultModel := range []string{strings.Repeat("x", 513), "model\n", "\xff"} {
		a := base
		a.DefaultModel = defaultModel
		if _, err := report(a); err == nil {
			t.Fatal("接受了无效默认模型")
		}
	}
	a = base
	a.Models = []RuntimeModel{}
	if _, err := report(a); err != nil {
		t.Fatal("空列表不能上报已知默认模型", err)
	}
	legacy := []byte(`{"exec":{"shell":"sh"},"agents":[{"agent_type":"codex","version":"1.2.3","status":"available","capabilities":{"create":true},"future":true}]}`)
	decoded = RuntimeReport{}
	if DecodeRuntimeMessage(legacy, &decoded) != nil {
		t.Fatal("旧版模型字段缺省报告无法读取")
	}
	if _, err := RuntimeReportJSON(decoded); err != nil || decoded.Agents[0].DefaultModel != "" || decoded.Agents[0].Capabilities.SwitchModel {
		t.Fatalf("旧版模型能力缺省值错误：%+v %v", decoded, err)
	}
	extended := []byte(`{"exec":{"shell":"sh"},"agents":[{"agent_type":"pi","version":"1.2.3","status":"available","models":[{"id":"provider/model","name":"Model","future":true}],"default_model":"provider/model","capabilities":{"switch_model":true,"future":true}}]}`)
	if DecodeRuntimeMessage(extended, &decoded) != nil {
		t.Fatal("模型字段扩展无法读取")
	}
	saved, err := RuntimeReportJSON(decoded)
	if err != nil || strings.Contains(string(saved), "future") || decoded.Agents[0].Models[0].ID != "provider/model" {
		t.Fatalf("模型扩展字段处理错误：%s %v", saved, err)
	}
}

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
