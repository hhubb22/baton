package task

import (
	"strings"
	"testing"
)

func TestOversizedExecutorInputNamesTheFields(t *testing.T) {
	big := strings.Repeat("测", 32768)
	in := Input{
		RequestID:          "too-big",
		Description:        big,
		AuthorizationScope: &big,
		ExpectedOutputs:    &big,
	}
	err := Validate(in)
	rej, ok := err.(*Rejection)
	if !ok || rej.Code != CodeInvalidRequest {
		t.Fatalf("超限输入没有被拒绝: %v", err)
	}
	want := []string{"description", "authorization_scope", "expected_outputs"}
	if strings.Join(rej.Fields, ",") != strings.Join(want, ",") {
		t.Fatalf("超限字段是 %v", rej.Fields)
	}
	raw, err := MarshalExecutorInput(in.Description, in.AuthorizationScope, in.ExpectedOutputs, nil, nil, 1)
	if err != nil || len(raw) <= ExecutorInputLimit {
		t.Fatalf("序列化后的输入没有超过上限: %v %d", err, len(raw))
	}
}

func TestExecutorInputAtLimitIsAccepted(t *testing.T) {
	in := Input{RequestID: "fits", Description: "调查"}
	if err := Validate(in); err != nil {
		t.Fatal(err)
	}
	raw, err := MarshalExecutorInput(in.Description, nil, nil, nil, nil, 1)
	if err != nil || len(raw) > ExecutorInputLimit {
		t.Fatalf("正常输入被当成超限: %v %d", err, len(raw))
	}
}
