package task

import (
	"bytes"
	"strings"
	"testing"
)

func TestRequiredArtifactsValidationAndHash(t *testing.T) {
	ref := ArtifactRef{NodeID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", RootID: "build", Path: "firmware.bin"}
	in := Input{RequestID: "artifacts", Description: "依赖产物", RequiredArtifacts: []ArtifactRef{ref}}
	if err := Validate(in); err != nil {
		t.Fatal(err)
	}
	initial := mustHash(t, in)
	in.RequiredArtifacts[0].NodeID = strings.ToUpper(ref.NodeID)
	if !bytes.Equal(initial, mustHash(t, in)) {
		t.Fatal("UUID 大小写改变产物摘要")
	}
	in.RequiredArtifacts[0].Path = "other.bin"
	if bytes.Equal(initial, mustHash(t, in)) {
		t.Fatal("产物路径没有纳入幂等摘要")
	}
	for _, bad := range []ArtifactRef{
		{NodeID: "not-uuid", RootID: ref.RootID, Path: ref.Path},
		{NodeID: ref.NodeID, RootID: "../build", Path: ref.Path},
		{NodeID: ref.NodeID, RootID: ref.RootID, Path: ""},
		{NodeID: ref.NodeID, RootID: ref.RootID, Path: "a\nfile"},
		{NodeID: ref.NodeID, RootID: ref.RootID, Path: strings.Repeat("a", maxRefRunes+1)},
	} {
		in.RequiredArtifacts = []ArtifactRef{bad}
		if err := Validate(in); err == nil {
			t.Fatalf("接受非法产物: %+v", bad)
		}
	}
	in.RequiredArtifacts = make([]ArtifactRef, maxResultRefs+1)
	if err := Validate(in); err == nil {
		t.Fatal("接受过多引用")
	}
}

func TestArtifactReferencesCountTowardMessageLimit(t *testing.T) {
	big := strings.Repeat("测", 29000)
	in := Input{RequestID: "size", Description: big, AuthorizationScope: &big, ExpectedOutputs: &big}
	if err := Validate(in); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxResultRefs; i++ {
		in.RequiredArtifacts = append(in.RequiredArtifacts, ArtifactRef{NodeID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", RootID: "build", Path: strings.Repeat("测", maxRefRunes)})
	}
	rej, ok := Validate(in).(*Rejection)
	if !ok || !strings.Contains(strings.Join(rej.Fields, ","), "required_artifacts") {
		t.Fatalf("产物没有计入消息上限: %+v", rej)
	}
}
