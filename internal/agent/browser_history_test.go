package agent

import (
	"crypto/sha256"
	"encoding/json"
	"strings"
	"testing"

	"baton/internal/protocol"
)

func TestHistoryPagerBoundsEscapedMetadata(t *testing.T) {
	pager, err := NewHistoryPager("native:session", "", 16)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]string{"id": strings.Repeat("<", 256), "parentId": strings.Repeat("<", 256), "type": strings.Repeat("<", 256), "text": "正文"})
	more, err := pager.Add(raw, sha256.Sum256(raw), int64(len(raw)), strings.Repeat("<", 10000))
	if err != nil || !more {
		t.Fatal("恶意元数据没有生成受限引用", err)
	}
	page, err := pager.Finish("")
	if err != nil || !protocol.ValidHistoryPage(&page) || !page.Gap {
		t.Fatal("恶意元数据超限或缺口未显示", err)
	}
}
