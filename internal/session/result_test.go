package session

import (
	"encoding/json"
	"strings"
	"testing"

	"baton/internal/protocol"
)

func TestCandidateSubmissionIsBoundAndIdempotent(t *testing.T) {
	t.Setenv("BATON_TEST_EXECUTOR_SCRIPT", "running")
	w, _, sessionID := clockWorker(t, 60)
	if _, err := w.SubmitInput(sessionID, `{"description":"来源"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := w.SubmitResult(sessionID, w.task, w.execution, "完成"); err == nil {
		t.Fatal("自由文本变成成功")
	}
	if _, err := w.SubmitResult(sessionID, w.task, mustSessionID(t), successDocument()); err == nil {
		t.Fatal("替换了执行身份")
	}
	reports, err := w.SubmitResult(sessionID, w.task, w.execution, successDocument())
	if err != nil {
		t.Fatal(err)
	}
	var eventID string
	for _, report := range reports {
		if report.Kind != protocol.ReportResult {
			continue
		}
		var result protocol.ExecutionReport
		if err := json.Unmarshal(report.Body, &result); err != nil {
			t.Fatal(err)
		}
		if result.TaskID != w.task || result.ExecutionID != w.execution || result.SessionID != sessionID || !result.AgentStopped {
			t.Fatal("候选身份成为可信字段或缺失停止确认")
		}
		eventID = report.EventID
	}
	if eventID == "" {
		t.Fatal("没有候选结果")
	}
	if err := w.Ack(eventID); err != nil {
		t.Fatal(err)
	}
	if _, err := w.SubmitResult(sessionID, w.task, w.execution, successDocument()); err != nil {
		t.Fatal("重复提交未返回原事实")
	}
	changed := strings.Replace(successDocument(), SuccessSummary, "不同摘要", 1)
	if _, err := w.SubmitResult(sessionID, w.task, w.execution, changed); err == nil {
		t.Fatal("冲突结果覆盖了已保存事实")
	}
	var count int
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM outbox WHERE kind = ?`, protocol.ReportResult).Scan(&count); err != nil || count != 1 || w.observer.Inputs() != 1 {
		t.Fatal("提交或查询重复执行")
	}
}
