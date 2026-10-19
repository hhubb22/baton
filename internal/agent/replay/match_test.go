package replay

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestMatchBoundNativePath(t *testing.T) {
	root := t.TempDir()
	expected := json.RawMessage(`"<workspace>/sessions/<$session>/native"`)
	actual, _ := json.Marshal(filepath.Join(root, "sessions", "runtime", "native"))
	captures := map[string]any{}
	if err := Match(expected, actual, map[string]string{"<workspace>": root}, captures); err != nil {
		t.Fatal(err)
	}
	if captures["<$session>"] != "runtime" {
		t.Fatal(captures)
	}
	// 只有路径中的分隔符可按平台转换；工作目录之外的路径仍必须失配。
	outside, _ := json.Marshal(filepath.Join(t.TempDir(), "sessions", "runtime", "native"))
	if err := Match(expected, outside, map[string]string{"<workspace>": root}, captures); err == nil {
		t.Fatal("接受了另一工作目录")
	}
	if err := Match(json.RawMessage(`"<tools>/read"`), json.RawMessage(`"<tools>\\read"`), map[string]string{}, map[string]any{}); err == nil {
		t.Fatal("未声明文本的分隔符被改写")
	}
}
