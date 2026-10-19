package protocol

const (
	// BodyFileBrowse 是发给节点的临时文件浏览请求。Gateway 不解释 body，中心也不把它写入业务 outbox。
	BodyFileBrowse = "files.browse"
	// BodyFileResult 是节点对一次浏览请求的结果。
	BodyFileResult = "files.browse_result"

	// FilePreviewBytes 是单次文本预览的上限。超出只返回截断标志和剩余内容引用。
	FilePreviewBytes = 64 * 1024
	// FileListPage 是一次目录响应最多返回的条目数。
	FileListPage = 200
	// FileListScan 是一次目录扫描最多读取的条目数，避免临时 RPC 遍历超大目录。
	FileListScan = 1024

	FileKindRoots     = "roots"
	FileKindDirectory = "directory"
	FileKindFile      = "file"
	FileKindSymlink   = "symlink"
	FileKindFIFO      = "fifo"
	FileKindDevice    = "device"
	FileKindSocket    = "socket"
	FileKindSpecial   = "special"

	FileCodePathEscaped   = "path_escaped"
	FileCodeRootForbidden = "root_forbidden"
	FileCodeInvalidPath   = "invalid_path"
	FileCodeNotFound      = "not_found"
	FileCodeNotText       = "not_text"
	FileCodeUnsupported   = "unsupported_type"
	FileCodeUnavailable   = "unavailable"
)

// FileRequest 是一次浏览。浏览器侧只能提供 root_id 和相对路径，不能提供绝对路径或读取偏移。
type FileRequest struct {
	Type        string `json:"type"`
	OperationID string `json:"operation_id"`
	RootID      string `json:"root_id,omitempty"`
	Path        string `json:"path,omitempty"`
	Cursor      string `json:"cursor,omitempty"`
}

// FileRoot 是节点本地配置的一个授权目录。响应只含标识，不含本机绝对路径。
type FileRoot struct {
	ID string `json:"id"`
}

// FileEntry 是目录中的一条。符号链接不展开目标路径。
type FileEntry struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	Size *int64 `json:"size,omitempty"`
}

// FileRemainder 指向尚未通过预览返回的剩余内容或未列完的目录。它不是继续下载的凭据。
type FileRemainder struct {
	RootID      string `json:"root_id"`
	Path        string `json:"path"`
	Kind        string `json:"kind"`
	Offset      int64  `json:"offset,omitempty"`
	Size        int64  `json:"size,omitempty"`
	Listed      int    `json:"listed,omitempty"`
	ScanLimited bool   `json:"scan_limited,omitempty"`
}

// FileResult 是浏览的业务结果。OK 为 false 时不携带文件内容。
type FileResult struct {
	Type        string         `json:"type"`
	OperationID string         `json:"operation_id"`
	OK          bool           `json:"ok"`
	Code        string         `json:"code,omitempty"`
	Message     string         `json:"message,omitempty"`
	Kind        string         `json:"kind,omitempty"`
	RootID      string         `json:"root_id,omitempty"`
	Path        string         `json:"path,omitempty"`
	Roots       []FileRoot     `json:"roots,omitempty"`
	Entries     []FileEntry    `json:"entries,omitempty"`
	Content     *string        `json:"content,omitempty"`
	Size        *int64         `json:"size,omitempty"`
	Truncated   bool           `json:"truncated,omitempty"`
	Remainder   *FileRemainder `json:"remainder,omitempty"`
	NextCursor  string         `json:"next_cursor,omitempty"`
}
