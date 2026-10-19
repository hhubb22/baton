package task

import "testing"

func TestParseCandidateIgnoresForgedAssociation(t *testing.T) {
	raw := `{
		"summary":"计数执行器已交回结构化结果",
		"evidence":[{"storage_ref":"executor-note","resource_id":"count-1","access_status":"available"}],
		"artifacts":[],
		"artifacts_empty_reason":"这次执行没有文件产物",
		"error":null,
		"status":"completed",
		"task_id":"11111111-1111-4111-8111-111111111111",
		"target_node_id":"22222222-2222-4222-8222-222222222222",
		"session_id":"33333333-3333-4333-8333-333333333333"
	}`
	got, err := ParseCandidate(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusCompleted || got.Summary == "" || len(got.Evidence) != 1 || len(got.Artifacts) != 0 {
		t.Fatalf("候选结果不正确: %+v", got)
	}
	if got.ErrorCode != "" {
		t.Fatalf("成功结果带了错误: %+v", got)
	}
}

func TestParseCandidateRejectsFreeTextAndIncompleteResults(t *testing.T) {
	samples := []string{
		`完成`,
		``,
		`{"summary":"好","status":"completed"}`,
		`{"summary":"好","status":"completed","evidence":[],"artifacts":[],"evidence_empty_reason":"无","artifacts_empty_reason":"无","error":{"code":"execution_failed","message":"失败"}}`,
		`{"summary":"好","status":"failed","evidence":[],"artifacts":[],"evidence_empty_reason":"无","artifacts_empty_reason":"无","error":null}`,
		`{"summary":"好","status":"completed","evidence":[{"resource_id":"x","access_status":"available"}],"artifacts":[],"artifacts_empty_reason":"无","error":null}`,
		`{"summary":"好","status":"running","evidence":[],"artifacts":[],"evidence_empty_reason":"无","artifacts_empty_reason":"无","error":null}`,
	}
	for _, raw := range samples {
		if _, err := ParseCandidate(raw); err == nil {
			t.Fatalf("无效结果被接受: %s", raw)
		}
	}
	if err := ValidateCandidate(FormatFailure(false)); err != nil {
		t.Fatal(err)
	}
	uncertain := FormatFailure(true)
	if err := ValidateCandidate(uncertain); err != nil || uncertain.Status != StatusNeedsVerification {
		t.Fatalf("不确定的格式错误不正确: %+v %v", uncertain, err)
	}
}

func TestCommandResultValidation(t *testing.T) {
	base := Candidate{Status: StatusCompleted, Summary: "命令已完成", EvidenceEmptyReason: "输出保存在命令结果中", ArtifactsEmptyReason: "没有声明产物"}
	samples := []struct {
		name   string
		result CommandResult
		valid  bool
	}{
		{"empty", CommandResult{}, true},
		{"text", CommandResult{Output: "hello", TotalBytes: 5}, true},
		{"binary", CommandResult{Encoding: "base64", Output: "AP8=", TotalBytes: 2}, true},
		{"invalid_base64", CommandResult{Encoding: "base64", Output: "%%%", TotalBytes: 2}, false},
		{"raw_nul", CommandResult{Output: "\x00", TotalBytes: 1}, false},
		{"unsupported_encoding", CommandResult{Encoding: "hex", Output: "00", TotalBytes: 1}, false},
		{"wrong_size", CommandResult{Output: "hello", TotalBytes: 6}, false},
		{"negative_size", CommandResult{TotalBytes: -1}, false},
		{"incorrect_truncation", CommandResult{Truncated: true}, false},
		{"nonzero_success", CommandResult{ExitCode: 1}, false},
	}
	for _, sample := range samples {
		t.Run(sample.name, func(t *testing.T) {
			candidate := base
			candidate.CommandResult = &sample.result
			err := ValidateCandidate(candidate)
			if (err == nil) != sample.valid {
				t.Fatalf("校验结果=%v valid=%v", err, sample.valid)
			}
		})
	}
}
