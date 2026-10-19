package control

import (
	"baton/internal/projectagent"
	"fmt"
	"testing"
	"time"
)

func TestProjectPreviewSnapshotsExpireAndStayBounded(t *testing.T) {
	s := &Server{}
	for i := 0; i < 140; i++ {
		s.saveProjectPreview(fmt.Sprint(i), projectagent.Preview{AfterSeq: 2, Text: "临时回复"})
	}
	if len(s.projectPreviews) != 128 {
		t.Fatalf("快照数量 %d", len(s.projectPreviews))
	}
	if s.ProjectPreview("139", 1) != nil {
		t.Fatal("已保存的回复仍显示旧预览")
	}
	value := s.ProjectPreview("139", 2)
	if value == nil || value.Text != "临时回复" {
		t.Fatal("没有快照")
	}
	value.Text = "修改返回副本"
	if s.ProjectPreview("139", 2).Text != "临时回复" {
		t.Fatal("快照被外部修改")
	}
	s.projectPreviews["139"] = projectagent.Preview{AfterSeq: 2, Text: "已过期", UpdatedAt: time.Now().Add(-time.Minute)}
	if s.ProjectPreview("139", 2) != nil {
		t.Fatal("返回过期快照")
	}
}
