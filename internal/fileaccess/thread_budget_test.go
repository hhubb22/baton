package fileaccess

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"baton/internal/protocol"
)

func TestThreadAttachmentBudgetPreservesSourcesBeforeEnrichment(t *testing.T) {
	refs := []ThreadAttachment{}
	for i := range 16 {
		size := int64(i)
		path := fmt.Sprintf("packages/components/src/generated/Component%02d.tsx", i)
		refs = append(refs, ThreadAttachment{Kind: "file", NodeID: "11111111-1111-4111-8111-111111111111", RootID: "workspace", Path: path, AbsolutePath: "/workspace/" + strings.Repeat("organization/", 20) + path, Size: &size, AccessStatus: "available"})
	}
	original, _ := json.Marshal(refs)
	bounded := boundThreadAttachments(refs)
	if len(bounded) != len(refs) || !threadAttachmentsFit(bounded) {
		t.Fatalf("sources lost or budget exceeded: %d", len(bounded))
	}
	for i, ref := range bounded {
		core, want := ref, refs[i]
		core.AbsolutePath = ""
		core.Size = nil
		want.AbsolutePath = ""
		want.Size = nil
		if !reflect.DeepEqual(core, want) {
			t.Fatalf("source changed: %+v != %+v", core, want)
		}
		if ref.Size != nil && *ref.Size != *refs[i].Size {
			t.Fatal("size changed")
		}
		if ref.AbsolutePath != "" && ref.AbsolutePath != refs[i].AbsolutePath {
			t.Fatal("absolute path changed")
		}
	}
	after, _ := json.Marshal(refs)
	if string(after) != string(original) {
		t.Fatal("source slice mutated")
	}
}

func TestThreadAttachmentBudgetIncludesJSONBFormatting(t *testing.T) {
	// 数值只用 int64；逗号、冒号、引号和反斜杠在字符串中不增加 JSONB 的分隔空格。
	ref := ThreadAttachment{Kind: "file", NodeID: "node", RootID: "root", Path: `comma,:quote"backslash\`, AccessStatus: "available"}
	raw, _ := json.Marshal([]ThreadAttachment{ref})
	ref.Path += strings.Repeat("x", protocol.MaxThreadAttachmentsBytes-len(raw)-1)
	raw, _ = json.Marshal([]ThreadAttachment{ref})
	if len(raw) >= protocol.MaxThreadAttachmentsBytes {
		t.Fatalf("fixture must fit compact JSON: %d", len(raw))
	}
	if threadAttachmentsFit([]ThreadAttachment{ref}) {
		t.Fatal("JSONB separator spaces were not reserved")
	}
	if got := boundThreadAttachments([]ThreadAttachment{ref, {Kind: "commit", Repo: "example.com/repo", SHA: "1234567"}}); len(got) != 1 || got[0].Kind != "commit" {
		t.Fatalf("oversize source was split or blocked subsequent reference: %+v", got)
	}
	escaped := []ThreadAttachment{{Kind: "file", NodeID: "node", RootID: "root", Path: strings.Repeat("<>&\u2028", 180), AccessStatus: "available"}}
	if got := boundThreadAttachments(escaped); !threadAttachmentsFit(got) {
		t.Fatal("escaped fields exceeded JSONB budget")
	}
}
