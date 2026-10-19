package inbox_test

import (
	"baton/internal/inbox"
	"strings"
	"testing"
)

func TestMarkdownContent(t *testing.T) {
	for _, content := range []string{
		"# 表格与代码\n\n|a|b|\n|-|-|\n|1|2|\n\n**粗体** [链接](https://example.org/a)",
		"[引用][ref]\n\n[ref]: https://example.org \"标题\"",
		"<https://example.org>", "https://example.org/a", "[转义](https\\://example.org)",
		"```md\n[示例](http://example.org)\n```", "`[示例](javascript:alert)`",
		"<div>原始 HTML 不渲染</div>", "Card(未知组件)", strings.Repeat("a", 32<<10),
	} {
		if err := inbox.ValidateContent(content); err != nil {
			t.Errorf("合法内容被拒绝 %q: %v", content[:min(len(content), 70)], err)
		}
	}
	for _, content := range []string{
		strings.Repeat("a", (32<<10)+1), "[链接](http://example.org)", "[链接](javascript:alert)",
		"[链接](/relative)", "[链接](//example.org)", "<http://example.org>", "<person@example.org>",
		"http://example.org/a", "www.example.org", "[引用][ref]\n\n[ref]: ftp://example.org",
		"[链接](java&#x73;cript:alert)", "[链接](https:relative)", "[链接](https://)",
	} {
		if err := inbox.ValidateContent(content); err == nil {
			t.Errorf("非法内容被接受 %q", content[:min(len(content), 70)])
		}
	}
}
func TestAskValidation(t *testing.T) {
	valid := func() inbox.Ask {
		return inbox.Ask{Title: "选择", Options: []inbox.Option{{ID: "go", Label: "继续", Recommended: true}}}
	}
	for _, change := range []func(*inbox.Ask){
		func(a *inbox.Ask) { a.Title = "" }, func(a *inbox.Ask) { a.Title = strings.Repeat("中", 121) },
		func(a *inbox.Ask) { a.Summary = strings.Repeat("中", 281) }, func(a *inbox.Ask) { a.Options = nil },
		func(a *inbox.Ask) { a.Options = append(a.Options, a.Options[0]) },
		func(a *inbox.Ask) {
			a.Options = append(a.Options, inbox.Option{ID: "stop", Label: "停止", Recommended: true})
		},
		func(a *inbox.Ask) { a.Options[0].ID = "Bad" }, func(a *inbox.Ask) { a.Options[0].Label = "" },

		func(a *inbox.Ask) { a.TaskID = "invalid" },
	} {
		a := valid()
		change(&a)
		if a.Validate() == nil {
			t.Errorf("参数被接受 %+v", a)
		}
	}
	a := valid()
	if err := a.Validate(); err != nil {
		t.Fatal(err)
	}
	a.Options = nil
	a.AllowText = true
	if err := a.Validate(); err != nil {
		t.Fatal(err)
	}
}
