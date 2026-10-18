package fileaccess

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"unicode/utf8"

	"baton/internal/identity"
	"baton/internal/privatefile"
	"baton/internal/protocol"

	"github.com/gofrs/flock"
)

const (
	browseRootsFile = "browse-roots.json"
	browseLockFile  = "browse-roots.lock"
	maxBrowseRoots  = 32
	maxBrowsePath   = 4096
)

var rootIDPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)

// BrowseRoot 是节点本地保存的一个可浏览目录。绝对路径只留在节点上。
type BrowseRoot struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

// BrowseError 是可以返回给调用方的浏览错误，不包含绝对路径或文件内容。
type BrowseError struct {
	Code    string
	Message string
}

func (e *BrowseError) Error() string {
	if e == nil || e.Message == "" {
		return "无法浏览该路径"
	}
	return e.Message
}

type browseConfig struct {
	Roots []BrowseRoot `json:"roots"`
}

func PrepareDataDir(dir string) error {
	if strings.TrimSpace(dir) == "" || dir == "." {
		return errors.New("节点数据目录无效")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return errors.New("无法创建节点数据目录")
	}
	if err := privatefile.ProtectDir(dir); err != nil {
		return errors.New("无法限制节点数据目录的权限")
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return errors.New("无法读取节点数据目录")
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("节点数据目录无效")
	}
	if err := privatefile.CheckDir(dir); err != nil {
		return errors.New("节点数据目录允许其他用户进入")
	}
	return nil
}

// AddBrowseRoot 把一个本机目录登记为可浏览根。路径必须是已存在的真实目录，不能是符号链接。
func AddBrowseRoot(dir, id, rootPath string) error {
	if !rootIDPattern.MatchString(id) {
		return &BrowseError{Code: protocol.FileCodeInvalidPath, Message: "目录标识不正确"}
	}
	cleaned, err := cleanRootPath(rootPath)
	if err != nil {
		return err
	}
	info, err := os.Lstat(cleaned)
	if err != nil {
		return &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录无法打开"}
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return &BrowseError{Code: protocol.FileCodePathEscaped, Message: "路径超出允许的目录"}
	}
	opened, err := openConfiguredRoot(cleaned)
	if err != nil {
		return err
	}
	_ = opened.Close()
	unlock, err := lockBrowse(dir)
	if err != nil {
		return err
	}
	defer unlock()
	roots, err := readBrowseRoots(dir)
	if err != nil {
		return err
	}
	for _, root := range roots {
		if root.ID == id {
			return &BrowseError{Code: protocol.FileCodeInvalidPath, Message: "浏览目录标识已存在"}
		}
	}
	if len(roots) >= maxBrowseRoots {
		return &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	roots = append(roots, BrowseRoot{ID: id, Path: cleaned})
	return writeBrowseRoots(dir, roots)
}

// RemoveBrowseRoot 删除一个已登记的浏览根。没有对应标识时返回错误。
func RemoveBrowseRoot(dir, id string) error {
	if !rootIDPattern.MatchString(id) {
		return &BrowseError{Code: protocol.FileCodeInvalidPath, Message: "目录标识不正确"}
	}
	unlock, err := lockBrowse(dir)
	if err != nil {
		return err
	}
	defer unlock()
	roots, err := readBrowseRoots(dir)
	if err != nil {
		return err
	}
	next := make([]BrowseRoot, 0, len(roots))
	found := false
	for _, root := range roots {
		if root.ID == id {
			found = true
			continue
		}
		next = append(next, root)
	}
	if !found {
		return &BrowseError{Code: protocol.FileCodeRootForbidden, Message: "不能浏览该目录"}
	}
	return writeBrowseRoots(dir, next)
}

// ListBrowseRoots 返回本机登记的浏览根。调用方在节点上，因此可以看到绝对路径。
func ListBrowseRoots(dir string) ([]BrowseRoot, error) {
	unlock, err := lockBrowse(dir)
	if err != nil {
		return nil, err
	}
	defer unlock()
	return readBrowseRoots(dir)
}

// CheckBrowseQuery 检查浏览器提交的 root_id、相对路径和目录游标。
// 通过字符串检查并不代替打开文件时的边界验证。
func CheckBrowseQuery(rootID, relPath, cursor string) error {
	if rootID == "" {
		if relPath != "" || cursor != "" {
			return &BrowseError{Code: protocol.FileCodeInvalidPath, Message: "列出授权目录时不能指定路径"}
		}
		return nil
	}
	if !rootIDPattern.MatchString(rootID) {
		return &BrowseError{Code: protocol.FileCodeInvalidPath, Message: "目录标识不正确"}
	}
	if _, err := normalizeRelative(relPath); err != nil {
		return err
	}
	if _, err := normalizeCursor(cursor); err != nil {
		return err
	}
	return nil
}

// Browse 按节点本地配置打开目标。返回的文件句柄来自打开结果，调用方不按路径再次打开。
func Browse(dir string, req protocol.FileRequest) protocol.FileResult {
	result := protocol.FileResult{Type: protocol.BodyFileResult, OperationID: req.OperationID}
	if _, err := identity.ParseUUID(req.OperationID); err != nil {
		return browseFail(result, protocol.FileCodeInvalidPath, "浏览请求无效")
	}
	if err := CheckBrowseQuery(req.RootID, req.Path, req.Cursor); err != nil {
		var browseErr *BrowseError
		if errors.As(err, &browseErr) {
			return browseFail(result, browseErr.Code, browseErr.Message)
		}
		return browseFail(result, protocol.FileCodeInvalidPath, "路径不正确")
	}
	roots, err := ListBrowseRoots(dir)
	if err != nil {
		return browseFail(result, protocol.FileCodeUnavailable, "浏览目录配置无法使用")
	}
	if req.RootID == "" {
		result.OK = true
		result.Kind = protocol.FileKindRoots
		result.Roots = make([]protocol.FileRoot, 0, len(roots))
		for _, root := range roots {
			result.Roots = append(result.Roots, protocol.FileRoot{ID: root.ID})
		}
		return result
	}
	rel, _ := normalizeRelative(req.Path)
	cursor, _ := normalizeCursor(req.Cursor)
	file, err := openAuthorized(roots, req.RootID, rel)
	if err != nil {
		return browseOpenFail(result, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return browseOpenFail(result, err)
	}
	if !openedKindAllowed(info) {
		return browseFail(result, protocol.FileCodeUnsupported, "只能浏览目录和普通文件")
	}
	result.OK = true
	result.RootID = req.RootID
	result.Path = rel
	if info.IsDir() {
		return listOpened(result, file, req.RootID, rel, cursor)
	}
	if cursor != "" {
		return browseFail(result, protocol.FileCodeInvalidPath, "不能按条目游标读取文件内容")
	}
	return previewOpened(result, file, info, req.RootID, rel)
}

func browseFail(result protocol.FileResult, code, message string) protocol.FileResult {
	return Fail(result, code, message)
}

func Fail(result protocol.FileResult, code, message string) protocol.FileResult {
	result.OK = false
	result.Code = code
	result.Message = message
	result.Kind = ""
	result.RootID = ""
	result.Path = ""
	result.Roots = nil
	result.Entries = nil
	result.Content = nil
	result.Size = nil
	result.Truncated = false
	result.Remainder = nil
	result.NextCursor = ""
	return result
}

func browseOpenFail(result protocol.FileResult, err error) protocol.FileResult {
	code, message := classifyOpen(err)
	return browseFail(result, code, message)
}

var errSpecialFile = errors.New("special file")

func openedKindAllowed(info os.FileInfo) bool {
	return info.IsDir() || info.Mode().IsRegular()
}

func classifyOpen(err error) (string, string) {
	var accessErr *BrowseError
	if errors.As(err, &accessErr) {
		return accessErr.Code, accessErr.Message
	}
	if errors.Is(err, errSpecialFile) {
		return protocol.FileCodeUnsupported, "只能浏览目录和普通文件"
	}
	if pathEscaped(err) {
		return protocol.FileCodePathEscaped, "路径超出允许的目录"
	}
	if errors.Is(err, os.ErrNotExist) {
		return protocol.FileCodeNotFound, "找不到该路径"
	}
	if errors.Is(err, os.ErrPermission) {
		return protocol.FileCodeUnavailable, "没有权限读取该路径"
	}
	return protocol.FileCodeUnavailable, "暂时无法浏览该路径"
}

func pathEscaped(err error) bool {
	if err == nil {
		return false
	}
	var browseErr *BrowseError
	if errors.As(err, &browseErr) {
		return browseErr.Code == protocol.FileCodePathEscaped
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) && pathErr.Err != nil {
		err = pathErr.Err
	}
	message := err.Error()
	return message == "path escapes from parent" ||
		message == "too many levels of symbolic links" ||
		message == "too many symlinks"
}

func listOpened(result protocol.FileResult, file *os.File, rootID, rel, cursor string) protocol.FileResult {
	scanned, scanLimited, err := readDirLimited(file, protocol.FileListScan)
	if err != nil {
		return browseOpenFail(result, err)
	}
	sort.Slice(scanned, func(i, j int) bool { return scanned[i].Name() < scanned[j].Name() })
	picked := make([]os.DirEntry, 0, protocol.FileListPage)
	for _, entry := range scanned {
		name := entry.Name()
		if !allowedEntryName(name) {
			continue
		}
		if cursor != "" && name <= cursor {
			continue
		}
		picked = append(picked, entry)
		if len(picked) > protocol.FileListPage {
			break
		}
	}
	truncated := false
	next := ""
	if len(picked) > protocol.FileListPage {
		truncated = true
		picked = picked[:protocol.FileListPage]
		next = picked[len(picked)-1].Name()
	}
	entries := make([]protocol.FileEntry, 0, len(picked))
	for _, entry := range picked {
		kind, size, ok := entryKind(entry)
		if !ok {
			continue
		}
		item := protocol.FileEntry{Name: entry.Name(), Kind: kind}
		if kind == protocol.FileKindFile {
			item.Size = &size
		}
		entries = append(entries, item)
	}
	result.Kind = protocol.FileKindDirectory
	result.Entries = entries
	result.Truncated = truncated || scanLimited
	result.NextCursor = next
	if result.Truncated {
		result.Remainder = &protocol.FileRemainder{
			RootID:      rootID,
			Path:        rel,
			Kind:        protocol.FileKindDirectory,
			Listed:      len(entries),
			ScanLimited: scanLimited,
		}
	}
	return result
}

func readDirLimited(file *os.File, limit int) ([]os.DirEntry, bool, error) {
	var all []os.DirEntry
	for {
		if len(all) > limit {
			return all[:limit], true, nil
		}
		batch, err := file.ReadDir(256)
		all = append(all, batch...)
		if errors.Is(err, io.EOF) {
			if len(all) > limit {
				return all[:limit], true, nil
			}
			return all, false, nil
		}
		if err != nil {
			return nil, false, err
		}
		if len(batch) == 0 {
			if len(all) > limit {
				return all[:limit], true, nil
			}
			return all, false, nil
		}
	}
}

func entryKind(entry os.DirEntry) (string, int64, bool) {
	info, err := entry.Info()
	if err != nil {
		mode := entry.Type()
		if mode == 0 {
			return "", 0, false
		}
		return kindFromMode(mode), 0, true
	}
	kind := kindFromMode(info.Mode())
	if kind == protocol.FileKindFile {
		size := info.Size()
		return kind, size, true
	}
	return kind, 0, true
}

func kindFromMode(mode os.FileMode) string {
	if mode&os.ModeSymlink != 0 {
		return protocol.FileKindSymlink
	}
	if mode.IsDir() {
		return protocol.FileKindDirectory
	}
	if mode&os.ModeNamedPipe != 0 {
		return protocol.FileKindFIFO
	}
	if mode&os.ModeSocket != 0 {
		return protocol.FileKindSocket
	}
	if mode&os.ModeDevice != 0 {
		return protocol.FileKindDevice
	}
	if mode.IsRegular() {
		return protocol.FileKindFile
	}
	return protocol.FileKindSpecial
}

func previewOpened(result protocol.FileResult, file *os.File, info os.FileInfo, rootID, rel string) protocol.FileResult {
	text, truncated, err := readPreview(file)
	if err != nil {
		if errors.Is(err, errNotText) {
			return browseFail(result, protocol.FileCodeNotText, "只能预览文本，不能通过浏览接口读取该文件")
		}
		return browseOpenFail(result, err)
	}
	size := info.Size()
	result.Kind = protocol.FileKindFile
	result.Content = &text
	result.Size = &size
	result.Truncated = truncated
	if truncated {
		result.Remainder = &protocol.FileRemainder{
			RootID: rootID,
			Path:   rel,
			Kind:   protocol.FileKindFile,
			Offset: int64(len(text)),
			Size:   size,
		}
	}
	return result
}

var errNotText = errors.New("not text")

func readPreview(file *os.File) (string, bool, error) {
	buf := make([]byte, protocol.FilePreviewBytes+1)
	n, err := io.ReadFull(file, buf)
	truncated := false
	if err == nil {
		truncated = true
		n = protocol.FilePreviewBytes
	} else if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
		err = nil
	}
	if err != nil {
		return "", false, err
	}
	chunk := buf[:n]
	if bytes.IndexByte(chunk, 0) >= 0 {
		return "", false, errNotText
	}
	if truncated {
		for len(chunk) > 0 && !utf8.Valid(chunk) {
			chunk = chunk[:len(chunk)-1]
		}
	}
	if !utf8.Valid(chunk) {
		return "", false, errNotText
	}
	return string(chunk), truncated, nil
}

func openConfiguredRoot(rootPath string) (*os.Root, error) {
	cleaned, err := cleanRootPath(rootPath)
	if err != nil {
		return nil, err
	}
	parent := filepath.Dir(cleaned)
	base := filepath.Base(cleaned)
	if parent == cleaned {
		opened, err := os.OpenRoot(cleaned)
		if err != nil {
			return nil, classifyRoot(err)
		}
		return opened, nil
	}
	parentRoot, err := os.OpenRoot(parent)
	if err != nil {
		return nil, classifyRoot(err)
	}
	defer parentRoot.Close()
	info, err := parentRoot.Lstat(base)
	if err != nil {
		return nil, classifyRoot(err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, &BrowseError{Code: protocol.FileCodePathEscaped, Message: "路径超出允许的目录"}
	}
	opened, err := parentRoot.OpenRoot(base)
	if err != nil {
		return nil, classifyRoot(err)
	}
	current, err := opened.Stat(".")
	if err != nil {
		_ = opened.Close()
		return nil, classifyRoot(err)
	}
	// 打开前后不是同一个目录时，说明中间被换成了符号链接或其他目录。
	if !os.SameFile(info, current) {
		_ = opened.Close()
		return nil, &BrowseError{Code: protocol.FileCodePathEscaped, Message: "路径超出允许的目录"}
	}
	return opened, nil
}

func classifyRoot(err error) error {
	if err == nil {
		return nil
	}
	var browseErr *BrowseError
	if errors.As(err, &browseErr) {
		return browseErr
	}
	code, message := classifyOpen(err)
	return &BrowseError{Code: code, Message: message}
}

func cleanRootPath(rootPath string) (string, error) {
	if strings.TrimSpace(rootPath) == "" || strings.ContainsRune(rootPath, 0) || len(rootPath) > maxBrowsePath {
		return "", &BrowseError{Code: protocol.FileCodeInvalidPath, Message: "路径不正确"}
	}
	if rootPath != strings.TrimSpace(rootPath) {
		return "", &BrowseError{Code: protocol.FileCodeInvalidPath, Message: "路径不正确"}
	}
	for _, r := range rootPath {
		if r < 0x20 || r == 0x7f {
			return "", &BrowseError{Code: protocol.FileCodeInvalidPath, Message: "路径不正确"}
		}
	}
	if !filepath.IsAbs(rootPath) {
		return "", &BrowseError{Code: protocol.FileCodeInvalidPath, Message: "路径不正确"}
	}
	cleaned := filepath.Clean(rootPath)
	if !filepath.IsAbs(cleaned) {
		return "", &BrowseError{Code: protocol.FileCodePathEscaped, Message: "路径超出允许的目录"}
	}
	return cleaned, nil
}

func normalizeRelative(relPath string) (string, error) {
	if relPath == "" || relPath == "." {
		return "", nil
	}
	if len(relPath) > maxBrowsePath || strings.ContainsRune(relPath, 0) || strings.Contains(relPath, "\\") {
		return "", &BrowseError{Code: protocol.FileCodeInvalidPath, Message: "路径不正确"}
	}
	for _, r := range relPath {
		if r < 0x20 || r == 0x7f {
			return "", &BrowseError{Code: protocol.FileCodeInvalidPath, Message: "路径不正确"}
		}
	}
	if strings.HasPrefix(relPath, "/") || filepath.IsAbs(relPath) {
		return "", &BrowseError{Code: protocol.FileCodePathEscaped, Message: "路径超出允许的目录"}
	}
	if len(relPath) >= 2 && relPath[1] == ':' {
		return "", &BrowseError{Code: protocol.FileCodePathEscaped, Message: "路径超出允许的目录"}
	}
	cleaned := path.Clean(relPath)
	if cleaned == "." {
		return "", nil
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") || path.IsAbs(cleaned) || strings.HasPrefix(cleaned, "/") {
		return "", &BrowseError{Code: protocol.FileCodePathEscaped, Message: "路径超出允许的目录"}
	}
	for _, part := range strings.Split(cleaned, "/") {
		if part == "" || part == "." || part == ".." {
			return "", &BrowseError{Code: protocol.FileCodePathEscaped, Message: "路径超出允许的目录"}
		}
	}
	return cleaned, nil
}

func normalizeCursor(cursor string) (string, error) {
	if cursor == "" {
		return "", nil
	}
	if len(cursor) > 255 || strings.ContainsRune(cursor, 0) || strings.ContainsAny(cursor, `/\`) {
		return "", &BrowseError{Code: protocol.FileCodeInvalidPath, Message: "路径不正确"}
	}
	for _, r := range cursor {
		if r < 0x20 || r == 0x7f {
			return "", &BrowseError{Code: protocol.FileCodeInvalidPath, Message: "路径不正确"}
		}
	}
	if cursor == "." || cursor == ".." {
		return "", &BrowseError{Code: protocol.FileCodePathEscaped, Message: "路径超出允许的目录"}
	}
	return cursor, nil
}

func allowedEntryName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 255 {
		return false
	}
	if strings.ContainsRune(name, 0) || strings.ContainsAny(name, `/\`) {
		return false
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func lockBrowse(dir string) (func(), error) {
	if err := PrepareDataDir(dir); err != nil {
		return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	lock := flock.New(filepath.Join(dir, browseLockFile))
	ok, err := lock.TryLock()
	if err != nil {
		return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	if !ok {
		return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置正被占用"}
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(filepath.Join(dir, browseLockFile), 0o600)
	}
	return func() { _ = lock.Unlock() }, nil
}

func readBrowseRoots(dir string) ([]BrowseRoot, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	defer root.Close()
	info, err := root.Lstat(browseRootsFile)
	if errors.Is(err, os.ErrNotExist) {
		return []BrowseRoot{}, nil
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	file, err := root.Open(browseRootsFile)
	if err != nil {
		if pathEscaped(err) {
			return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
		}
		return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 64<<10))
	if err != nil {
		return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var cfg browseConfig
	if err := dec.Decode(&cfg); err != nil {
		return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	if cfg.Roots == nil {
		cfg.Roots = []BrowseRoot{}
	}
	if len(cfg.Roots) > maxBrowseRoots {
		return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	seen := make(map[string]struct{}, len(cfg.Roots))
	for _, item := range cfg.Roots {
		if !rootIDPattern.MatchString(item.ID) {
			return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
		}
		if _, ok := seen[item.ID]; ok {
			return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
		}
		seen[item.ID] = struct{}{}
		cleaned, err := cleanRootPath(item.Path)
		if err != nil || cleaned != item.Path {
			return nil, &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
		}
	}
	sort.Slice(cfg.Roots, func(i, j int) bool { return cfg.Roots[i].ID < cfg.Roots[j].ID })
	return cfg.Roots, nil
}

func writeBrowseRoots(dir string, roots []BrowseRoot) error {
	if roots == nil {
		roots = []BrowseRoot{}
	}
	sort.Slice(roots, func(i, j int) bool { return roots[i].ID < roots[j].ID })
	body, err := json.MarshalIndent(browseConfig{Roots: roots}, "", "  ")
	if err != nil {
		return &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	body = append(body, '\n')
	tmp, err := os.CreateTemp(dir, ".browse-roots-*.tmp")
	if err != nil {
		return &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	tmpName := tmp.Name()
	written := false
	defer func() {
		if !written {
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		return &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	if err := tmp.Close(); err != nil {
		return &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	dest := filepath.Join(dir, browseRootsFile)
	if err := os.Rename(tmpName, dest); err != nil {
		return &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	written = true
	if err := os.Chmod(dest, 0o600); err != nil {
		return &BrowseError{Code: protocol.FileCodeUnavailable, Message: "浏览目录配置无法使用"}
	}
	if dirFile, err := os.Open(dir); err == nil {
		_ = dirFile.Sync()
		_ = dirFile.Close()
	}
	return nil
}
