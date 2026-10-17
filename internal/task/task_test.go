package task

import (
	"bytes"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestHashKeepsUnspecifiedDistinct(t *testing.T) {
	base := Input{RequestID: "req-1", Description: "调查天线"}
	first, err := Prepare(base)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Prepare(base)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.Hash, second.Hash) || len(first.Hash) != 32 {
		t.Fatal("相同原始字段的摘要不稳定")
	}
	if DefaultQueueTimeoutSeconds != 600 || DefaultExecutionTimeoutSeconds != 7200 {
		t.Fatal("默认期限与规格不一致")
	}

	nodeID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	upper := strings.ToUpper(nodeID)
	withNode := base
	withNode.TargetNodeID = &nodeID
	withUpper := base
	withUpper.TargetNodeID = &upper
	nodeHash := mustHash(t, withNode)
	if !bytes.Equal(nodeHash, mustHash(t, withUpper)) {
		t.Fatal("同一 UUID 的大小写被当成了不同内容")
	}
	if bytes.Equal(first.Hash, nodeHash) {
		t.Fatal("未指定目标与显式目标的摘要相同")
	}

	timeout := DefaultQueueTimeoutSeconds
	withTimeout := base
	withTimeout.QueueTimeoutSeconds = &timeout
	if bytes.Equal(first.Hash, mustHash(t, withTimeout)) {
		t.Fatal("省略期限与显式填写默认值的摘要相同")
	}

	empty := []string{}
	withEmpty := base
	withEmpty.DeviceNames = &empty
	if bytes.Equal(first.Hash, mustHash(t, withEmpty)) {
		t.Fatal("未指定设备与空列表的摘要相同")
	}
	a := []string{"scope", "meter"}
	b := []string{"meter", "scope"}
	left := base
	left.DeviceNames = &a
	right := base
	right.DeviceNames = &b
	if bytes.Equal(mustHash(t, left), mustHash(t, right)) {
		t.Fatal("设备名称顺序被忽略了")
	}
}

func TestValidateRequestShape(t *testing.T) {
	ok := Input{RequestID: "req-1", Description: "调查天线"}
	if err := Validate(ok); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		in    Input
		code  string
		field string
	}{
		{name: "empty id", in: Input{Description: "调查"}, code: CodeInvalidRequest, field: "request_id"},
		{name: "empty description", in: Input{RequestID: "req-1"}, code: CodeInvalidRequest, field: "description"},
		{name: "bad node", in: Input{RequestID: "req-1", Description: "调查", TargetNodeID: strPtr("node")}, code: CodeInvalidRequest, field: "target_node_id"},
		{name: "bad agent", in: Input{RequestID: "req-1", Description: "调查", AgentType: strPtr("Pi")}, code: CodeInvalidRequest, field: "agent_type"},
		{name: "zero queue", in: Input{RequestID: "req-1", Description: "调查", QueueTimeoutSeconds: intPtr(0)}, code: CodeInvalidRequest, field: "queue_timeout_seconds"},
		{name: "devices without scope", in: Input{RequestID: "req-1", Description: "调查", DeviceNames: &[]string{"meter"}}, code: CodeInvalidRequest, field: "authorization_scope"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := Validate(tc.in)
			rej, ok := err.(*Rejection)
			if !ok || rej.Code != tc.code || len(rej.Fields) != 1 || rej.Fields[0] != tc.field {
				t.Fatalf("得到 %#v", err)
			}
		})
	}
	session := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	if err := Validate(Input{RequestID: "req-1", Description: "调查", SourceSessionID: &session}); err != nil {
		t.Fatal(err)
	}
}

func TestMultilineTextAndLimits(t *testing.T) {
	base := Input{RequestID: "req-1", Description: "调查天线"}
	plain := mustHash(t, base)
	multi := base
	multi.Description = "调查天线\n第二行\r\n\t继续"
	multiHash := mustHash(t, multi)
	if bytes.Equal(plain, multiHash) || !bytes.Equal(multiHash, mustHash(t, multi)) {
		t.Fatal("换行没有稳定地进入摘要")
	}
	scope := "只读\n不改配置"
	withScope := multi
	withScope.AuthorizationScope = &scope
	if bytes.Equal(mustHash(t, multi), mustHash(t, withScope)) {
		t.Fatal("授权范围没有进入摘要")
	}
	outputs := "结论\t证据"
	withOutputs := multi
	withOutputs.ExpectedOutputs = &outputs
	if bytes.Equal(mustHash(t, multi), mustHash(t, withOutputs)) {
		t.Fatal("期望产物没有进入摘要")
	}
	if err := Validate(Input{
		RequestID:          "req-1",
		Description:        multi.Description,
		AuthorizationScope: &scope,
		ExpectedOutputs:    &outputs,
	}); err != nil {
		t.Fatal(err)
	}

	limit := strings.Repeat("测", 32767) + "\n"
	if utf8.RuneCountInString(limit) != 32768 {
		t.Fatalf("边界长度是 %d", utf8.RuneCountInString(limit))
	}
	if err := Validate(Input{
		RequestID:          "req-1",
		Description:        limit,
		AuthorizationScope: &limit,
		ExpectedOutputs:    &limit,
	}); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name  string
		in    Input
		field string
	}{
		{name: "description bell", in: Input{RequestID: "req-1", Description: "调查\x01"}, field: "description"},
		{name: "description vtab", in: Input{RequestID: "req-1", Description: "调查\v"}, field: "description"},
		{name: "description formfeed", in: Input{RequestID: "req-1", Description: "调查\f"}, field: "description"},
		{name: "description delete", in: Input{RequestID: "req-1", Description: "调查\x7f"}, field: "description"},
		{name: "description c1", in: Input{RequestID: "req-1", Description: "调查\u0085"}, field: "description"},
		{name: "scope bell", in: Input{RequestID: "req-1", Description: "调查", AuthorizationScope: strPtr("范围\x01")}, field: "authorization_scope"},
		{name: "outputs delete", in: Input{RequestID: "req-1", Description: "调查", ExpectedOutputs: strPtr("产物\x7f")}, field: "expected_outputs"},
		{name: "description too long", in: Input{RequestID: "req-1", Description: strings.Repeat("测", 32769)}, field: "description"},
		{name: "scope too long", in: Input{RequestID: "req-1", Description: "调查", AuthorizationScope: strPtr(strings.Repeat("测", 32769))}, field: "authorization_scope"},
		{name: "outputs too long", in: Input{RequestID: "req-1", Description: "调查", ExpectedOutputs: strPtr(strings.Repeat("测", 32769))}, field: "expected_outputs"},
		{name: "request newline", in: Input{RequestID: "req\n1", Description: "调查"}, field: "request_id"},
		{name: "request tab", in: Input{RequestID: "req\t1", Description: "调查"}, field: "request_id"},
		{name: "directory newline", in: Input{RequestID: "req-1", Description: "调查", WorkingDirectory: strPtr("/tmp\nwork")}, field: "working_directory"},
		{name: "directory tab", in: Input{RequestID: "req-1", Description: "调查", WorkingDirectory: strPtr("/tmp\twork")}, field: "working_directory"},
		{name: "blank lines", in: Input{RequestID: "req-1", Description: "\n\t\r"}, field: "description"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := Validate(tc.in)
			rej, ok := err.(*Rejection)
			if !ok || rej.Code != CodeInvalidRequest || len(rej.Fields) != 1 || rej.Fields[0] != tc.field {
				t.Fatalf("得到 %#v", err)
			}
		})
	}
}

func okInput() Input {
	return Input{RequestID: "req-1", Description: "调查天线"}
}

func mustHash(t *testing.T, in Input) []byte {
	t.Helper()
	prepared, err := Prepare(in)
	if err != nil {
		t.Fatal(err)
	}
	return prepared.Hash
}

func strPtr(s string) *string { return &s }

func intPtr(n int) *int { return &n }
