package node

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
)

func TestBrowseListsRootsAndPreviewsTextInsideRoot(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "notes")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "hello.txt"), []byte("hello from node\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := AddBrowseRoot(dir, "notes", root); err != nil {
		t.Fatal(err)
	}
	if err := AddBrowseRoot(dir, "notes", root); err == nil {
		t.Fatal("重复的 root_id 被接受")
	}
	listed, err := ListBrowseRoots(dir)
	if err != nil || len(listed) != 1 || listed[0].ID != "notes" || listed[0].Path != root {
		t.Fatalf("本机目录登记不正确: %+v %v", listed, err)
	}
	roots := Browse(dir, fileReq("", "", ""))
	if !roots.OK || roots.Kind != protocol.FileKindRoots || len(roots.Roots) != 1 || roots.Roots[0].ID != "notes" {
		t.Fatalf("授权目录列表不正确: %+v", roots)
	}
	if strings.Contains(mustText(roots.Roots[0].ID), root) {
		t.Fatal("授权目录响应包含绝对路径")
	}
	page := Browse(dir, fileReq("notes", "", ""))
	if !page.OK || page.Kind != protocol.FileKindDirectory || len(page.Entries) != 2 {
		t.Fatalf("目录列表不正确: %+v", page)
	}
	preview := Browse(dir, fileReq("notes", "hello.txt", ""))
	if !preview.OK || preview.Kind != protocol.FileKindFile || preview.Content == nil || *preview.Content != "hello from node\n" || preview.Truncated {
		t.Fatalf("文本预览不正确: %+v", preview)
	}
	if preview.Content != nil && strings.Contains(preview.Message, root) {
		t.Fatal("预览错误包含绝对路径")
	}
}

func TestBrowseTruncatesPreviewAndRejectsBinary(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "logs")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	body := strings.Repeat("A", protocol.FilePreviewBytes) + "TAIL_MARKER"
	if err := os.WriteFile(filepath.Join(root, "big.txt"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "bin.dat"), []byte{'h', 'i', 0, 'x'}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := AddBrowseRoot(dir, "logs", root); err != nil {
		t.Fatal(err)
	}
	preview := Browse(dir, fileReq("logs", "big.txt", ""))
	if !preview.OK || preview.Content == nil || !preview.Truncated || preview.Remainder == nil {
		t.Fatalf("超限预览没有截断: ok=%v truncated=%v", preview.OK, preview.Truncated)
	}
	if len(*preview.Content) != protocol.FilePreviewBytes || strings.Contains(*preview.Content, "TAIL_MARKER") {
		t.Fatalf("预览长度 %d，包含了剩余内容", len(*preview.Content))
	}
	if preview.Remainder.Offset != int64(len(*preview.Content)) || preview.Remainder.Size != int64(len(body)) {
		t.Fatalf("剩余内容引用不正确: %+v", preview.Remainder)
	}
	frame, err := encodeFileFrame("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", preview)
	if err != nil || len(frame) > protocol.MaxMessageBytes {
		t.Fatalf("预览帧超过消息上限: %d %v", len(frame), err)
	}
	binary := Browse(dir, fileReq("logs", "bin.dat", ""))
	if binary.OK || binary.Code != protocol.FileCodeNotText || binary.Content != nil {
		t.Fatalf("二进制文件被当成预览: %+v", binary)
	}
	controls := strings.Repeat("\x01", protocol.FilePreviewBytes)
	if err := os.WriteFile(filepath.Join(root, "controls.txt"), []byte(controls), 0o600); err != nil {
		t.Fatal(err)
	}
	fitted := fitFileResult(Browse(dir, fileReq("logs", "controls.txt", "")))
	frame, err = encodeFileFrame("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", fitted)
	if err != nil || len(frame) > protocol.MaxMessageBytes || fitted.Content == nil || strings.Contains(*fitted.Content, "\x00") {
		t.Fatalf("控制字符预览没有被限制在消息上限内: %d %v", len(frame), err)
	}
}

func TestBrowseRejectsEscapeUnknownRootAndOfflinePath(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "notes")
	outside := filepath.Join(dir, "outside")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("OUTSIDE_SENTINEL"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "inside.txt"), []byte("INSIDE"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "escape.txt")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("Windows 符号链接留给 T31")
		}
		t.Fatal(err)
	}
	insideLink := filepath.Join(root, "alias.txt")
	if err := os.Symlink("inside.txt", insideLink); err != nil {
		t.Fatal(err)
	}
	if err := AddBrowseRoot(dir, "notes", root); err != nil {
		t.Fatal(err)
	}
	escaped := Browse(dir, fileReq("notes", "escape.txt", ""))
	if escaped.OK || escaped.Code != protocol.FileCodePathEscaped || escaped.Content != nil || strings.Contains(escaped.Message, "OUTSIDE_SENTINEL") || strings.Contains(escaped.Message, outside) {
		t.Fatalf("符号链接逃逸没有被拒绝: %+v", escaped)
	}
	alias := Browse(dir, fileReq("notes", "alias.txt", ""))
	if !alias.OK || alias.Content == nil || *alias.Content != "INSIDE" {
		t.Fatalf("目录内符号链接没有打开实际目标: %+v", alias)
	}
	parent := Browse(dir, fileReq("notes", "../outside/secret.txt", ""))
	if parent.OK || parent.Code != protocol.FileCodePathEscaped || parent.Content != nil || strings.Contains(parent.Message, "OUTSIDE_SENTINEL") {
		t.Fatalf("路径越界没有被拒绝: %+v", parent)
	}
	absolute := Browse(dir, fileReq("notes", filepath.Join(outside, "secret.txt"), ""))
	if absolute.OK || absolute.Content != nil || strings.Contains(absolute.Message, "OUTSIDE_SENTINEL") {
		t.Fatalf("绝对路径没有被拒绝: %+v", absolute)
	}
	unknown := Browse(dir, fileReq("other", "inside.txt", ""))
	if unknown.OK || unknown.Code != protocol.FileCodeRootForbidden || unknown.Content != nil {
		t.Fatalf("未授权 root_id 没有被拒绝: %+v", unknown)
	}
	missing := Browse(dir, fileReq("notes", "missing.txt", ""))
	if missing.OK || missing.Code != protocol.FileCodeNotFound {
		t.Fatalf("缺失文件的结果不正确: %+v", missing)
	}
}

func TestBrowseRejectsDirectoryReplacedWithSymlink(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "notes")
	sub := filepath.Join(root, "sub")
	outside := filepath.Join(dir, "outside")
	if err := os.MkdirAll(filepath.Join(sub, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(outside, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "nested", "file.txt"), []byte("INSIDE"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "nested", "file.txt"), []byte("OUTSIDE_SENTINEL"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := AddBrowseRoot(dir, "notes", root); err != nil {
		t.Fatal(err)
	}
	before := Browse(dir, fileReq("notes", "sub/nested/file.txt", ""))
	if !before.OK || before.Content == nil || *before.Content != "INSIDE" {
		t.Fatalf("替换前没有读到目录内文件: %+v", before)
	}
	real := filepath.Join(root, "sub.real")
	if err := os.Rename(sub, real); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, sub); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("Windows 符号链接留给 T31")
		}
		t.Fatal(err)
	}
	after := Browse(dir, fileReq("notes", "sub/nested/file.txt", ""))
	if after.OK || after.Code != protocol.FileCodePathEscaped || after.Content != nil || strings.Contains(after.Message, "OUTSIDE_SENTINEL") {
		t.Fatalf("目录换成符号链接后仍然返回了目标: %+v", after)
	}
}

func TestBrowseSymlinkSwapDuringOpenDoesNotLeak(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "notes")
	sub := filepath.Join(root, "sub")
	outside := filepath.Join(dir, "outside")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "file.txt"), []byte("INSIDE"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "file.txt"), []byte("OUTSIDE_SENTINEL"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "probe")); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("Windows 符号链接留给 T31")
		}
		t.Fatal(err)
	}
	_ = os.Remove(filepath.Join(dir, "probe"))
	if err := AddBrowseRoot(dir, "notes", root); err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(root, "sub.real")
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = os.Rename(sub, real)
			_ = os.Symlink(outside, sub)
			time.Sleep(time.Millisecond)
			_ = os.Remove(sub)
			_ = os.Rename(real, sub)
			time.Sleep(time.Millisecond)
		}
	}()
	leaked := false
	deadline := time.Now().Add(400 * time.Millisecond)
	for time.Now().Before(deadline) {
		result := Browse(dir, fileReq("notes", "sub/file.txt", ""))
		text := ""
		if result.Content != nil {
			text = *result.Content
		}
		if strings.Contains(text, "OUTSIDE_SENTINEL") || strings.Contains(result.Message, "OUTSIDE_SENTINEL") || strings.Contains(result.Path, outside) {
			leaked = true
			break
		}
	}
	close(stop)
	wg.Wait()
	if leaked {
		t.Fatal("打开期间把目录换成符号链接后读到了目录外内容")
	}
}

func TestBrowseRejectsSymlinkRootAndPagesDirectory(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	link := filepath.Join(dir, "link")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("Windows 符号链接留给 T31")
		}
		t.Fatal(err)
	}
	if err := AddBrowseRoot(dir, "link", link); err == nil {
		t.Fatal("符号链接被登记为浏览目录")
	}
	root := filepath.Join(dir, "many")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < protocol.FileListPage+1; i++ {
		name := "f" + string(rune('a'+(i%26))) + strings.Repeat("x", 0)
		if i >= 26 {
			name = strings.Repeat("n", 3) + string(rune('a'+i%26)) + string(rune('a'+(i/26)%26))
		}
		if err := os.WriteFile(filepath.Join(root, uniqueName(i)), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		_ = name
	}
	if err := AddBrowseRoot(dir, "many", root); err != nil {
		t.Fatal(err)
	}
	first := Browse(dir, fileReq("many", "", ""))
	if !first.OK || !first.Truncated || len(first.Entries) != protocol.FileListPage || first.NextCursor == "" {
		t.Fatalf("目录第一页不正确: n=%d truncated=%v cursor=%q", len(first.Entries), first.Truncated, first.NextCursor)
	}
	second := Browse(dir, fileReq("many", "", first.NextCursor))
	if !second.OK || len(second.Entries) != 1 || second.Entries[0].Name <= first.NextCursor {
		t.Fatalf("目录下一页不正确: %+v", second.Entries)
	}
	fileCursor := Browse(dir, fileReq("many", second.Entries[0].Name, "zzzz"))
	if fileCursor.OK || fileCursor.Code != protocol.FileCodeInvalidPath || fileCursor.Content != nil {
		t.Fatalf("文件可以使用游标续读: %+v", fileCursor)
	}
}

func TestRemoveBrowseRoot(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "notes")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := AddBrowseRoot(dir, "notes", root); err != nil {
		t.Fatal(err)
	}
	if err := RemoveBrowseRoot(dir, "notes"); err != nil {
		t.Fatal(err)
	}
	result := Browse(dir, fileReq("notes", "", ""))
	if result.OK || result.Code != protocol.FileCodeRootForbidden {
		t.Fatalf("移除后仍可浏览: %+v", result)
	}
}

func fileReq(rootID, relPath, cursor string) protocol.FileRequest {
	id, err := identity.NewUUID()
	if err != nil {
		panic(err)
	}
	return protocol.FileRequest{
		Type:        protocol.BodyFileBrowse,
		OperationID: id,
		RootID:      rootID,
		Path:        relPath,
		Cursor:      cursor,
	}
}

func uniqueName(i int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz"
	return "f" + string(alphabet[i%26]) + string(alphabet[(i/26)%26]) + string(alphabet[(i/676)%26])
}

func mustText(value string) string { return value }
